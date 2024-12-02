import type { Completion } from '@codemirror/autocomplete';
import * as tsvfs from '@typescript/vfs';
import * as Comlink from 'comlink';
import ts, { type DiagnosticWithLocation } from 'typescript';
import type { LanguageServiceWorker, NodeDataFetcher } from '../types';
import { indexedDbCache } from './cache';
import {
	FILE_NAME,
	cmPosToTs,
	convertTSDiagnosticToCM,
	fnPrefix,
	isDiagnosticWithLocation,
	returnTypeForMode,
	schemaToTypescriptTypes,
	tsPosToCm,
	wrapInFunction,
} from './utils';

import { pascalCase } from 'change-case';
import type { CodeExecutionMode } from 'n8n-workflow';
import globalTypes from './type-declarations/globals.d.ts?raw';
import luxonTypes from './type-declarations/luxon.d.ts?raw';
import runOnceForAllItemsTypes from './type-declarations/n8n-once-for-all-items.d.ts?raw';
import runOnceForEachItemTypes from './type-declarations/n8n-once-for-each-item.d.ts?raw';
import n8nTypes from './type-declarations/n8n.d.ts?raw';
import { loadTypes } from './typesLoader';

self.process = { env: {} } as NodeJS.Process;

const TS_COMPLETE_BLOCKLIST: ts.ScriptElementKind[] = [ts.ScriptElementKind.warning];

const worker = (): LanguageServiceWorker => {
	let env: tsvfs.VirtualTypeScriptEnvironment;
	let nodeDataFetcher: NodeDataFetcher = async () => undefined;
	const loadedNodeTypesMap: Record<string, { type: string; typeName: string }> = {};
	let inputNodeNames: string[];
	let mode: CodeExecutionMode;

	function updateFile(fileName: string, content: string) {
		const exists = env.getSourceFile(fileName);
		if (exists) {
			env.updateFile(fileName, content);
		} else {
			env.createFile(fileName, content);
		}
	}

	async function loadNodeTypes(nodeName: string) {
		if (loadedNodeTypesMap[nodeName]) return;

		const data = await nodeDataFetcher(nodeName);

		if (data?.json) {
			const schema = data.json;
			const typeName = pascalCase(nodeName);
			const type = schemaToTypescriptTypes(schema, typeName);
			loadedNodeTypesMap[nodeName] = { type, typeName };
			updateFile(
				'n8n-dynamic.d.ts',
				`export {};

declare global {
	type NodeName = ${Object.keys(loadedNodeTypesMap)
		.map((name) => `'${name}'`)
		.join(' | ')};

    ${Object.values(loadedNodeTypesMap)
			.map(({ type }) => type)
			.join(';\n')}

	interface NodeDataMap {
	  ${Object.entries(loadedNodeTypesMap)
			.map(([nodeName, { typeName }]) => `'${nodeName}': NodeData<{}, ${typeName}, {}, {}>`)
			.join(';\n')}
	}
}`,
			);
		}
	}

	async function setInputNodeTypes(nodeName: string, mode: CodeExecutionMode) {
		const typeName = pascalCase(nodeName);
		updateFile(
			'n8n-dynamic-input.d.ts',
			`export {};

declare global {
    type N8nInputItem = N8nItem<${typeName}, {}>;

	interface N8nInput {
	${
		mode === 'runOnceForAllItems'
			? `all(branchIndex?: number, runIndex?: number): Array<N8nInputItem>;
first(branchIndex?: number, runIndex?: number): N8nInputItem;
last(branchIndex?: number, runIndex?: number): N8nInputItem;
itemMatching(itemIndex: number): N8nInputItem;`
			: 'item: N8nInputItem;'
	}
	}
}`,
		);
	}

	async function loadTypesIfNeeded(pos: number) {
		function findNode(node: ts.Node, check: (node: ts.Node) => boolean): ts.Node | undefined {
			if (check(node)) {
				return node;
			}

			return ts.forEachChild(node, (n) => findNode(n, check));
		}

		const file = env.getSourceFile(FILE_NAME);
		// If we are completing a N8nJson type -> fetch types first
		// $('Node A').item.json.
		if (file) {
			const node = findNode(
				file,
				(n) =>
					n.getStart() <= pos - 1 && n.getEnd() >= pos - 1 && n.kind === ts.SyntaxKind.Identifier,
			);

			if (!node) return;

			const callExpression = findNode(
				node.parent,
				(n) =>
					n.kind === ts.SyntaxKind.CallExpression &&
					(n as ts.CallExpression).expression.getText() === '$',
			);

			if (!callExpression) return;

			const nodeName = ((callExpression as ts.CallExpression).arguments.at(0) as ts.StringLiteral)
				?.text;

			if (!nodeName) return;

			await loadNodeTypes(nodeName);
		}
	}

	return {
		async init(options, nodeDataFetcherArg) {
			nodeDataFetcher = nodeDataFetcherArg;
			inputNodeNames = options.inputNodeNames;
			mode = options.mode;

			const compilerOptions: ts.CompilerOptions = {
				allowJs: true,
				checkJs: true,
				target: ts.ScriptTarget.ESNext,
				noLib: true,
				module: ts.ModuleKind.ESNext,
				strict: true,
				importHelpers: false,
				skipDefaultLibCheck: true,
				noEmit: true,
			};

			const cache = await indexedDbCache('typescript-cache', 'fs-map');
			const fsMap = await tsvfs.createDefaultMapFromCDN(
				compilerOptions,
				ts.version,
				true,
				ts,
				undefined,
				undefined,
				cache,
			);

			fsMap.set('globals.d.ts', globalTypes);
			fsMap.set('n8n.d.ts', n8nTypes);
			fsMap.set('luxon.d.ts', luxonTypes);
			fsMap.set('n8n-dynamic.d.ts', 'export {}');
			fsMap.set(
				'n8n-dynamic-input.d.ts',
				`export {};
declare global {
  interface N8nInput {
	${
		mode === 'runOnceForAllItems'
			? `all(branchIndex?: number, runIndex?: number): Array<N8nItem>;
	first(branchIndex?: number, runIndex?: number): N8nItem;
	last(branchIndex?: number, runIndex?: number): N8nItem;
	itemMatching(itemIndex: number): N8nItem;`
			: 'item: N8nItem;'
	}
  }
}`,
			);
			fsMap.set(FILE_NAME, wrapInFunction(options.content, mode));

			fsMap.set(
				'n8n-mode-specific.d.ts',
				mode === 'runOnceForAllItems' ? runOnceForAllItemsTypes : runOnceForEachItemTypes,
			);

			const system = tsvfs.createSystem(fsMap);
			env = tsvfs.createVirtualTypeScriptEnvironment(
				system,
				Array.from(fsMap.keys()),
				ts,
				compilerOptions,
			);

			if (options.variables) {
				env.createFile(
					'n8n-variables.d.ts',
					`export {}
declare global {
  interface N8nVars {
    ${options.variables.map((key) => `${key}: string;`).join('\n')}
  }
}`,
				);
			}

			if (cache.getItem('/node_modules/@types/luxon/package.json')) {
				const fileMap = await cache.getAllWithPrefix('/node_modules/@types/luxon');

				for (const [path, content] of Object.entries(fileMap)) {
					env.createFile(path, content);
				}
			} else {
				await loadTypes('luxon', '3.2.0', (path, types) => {
					cache.setItem(path, types);
					env.createFile(path, types);
				});
			}

			await Promise.all(
				options.inputNodeNames.map(async (nodeName) => await loadNodeTypes(nodeName)),
			);
			await Promise.all(
				inputNodeNames.map(async (nodeName) => await setInputNodeTypes(nodeName, mode)),
			);
		},
		updateFile: (content) => updateFile(FILE_NAME, wrapInFunction(content, mode)),
		async getCompletionsAtPos(pos) {
			const tsPos = cmPosToTs(pos, fnPrefix(returnTypeForMode(mode)));

			await loadTypesIfNeeded(tsPos);

			const completionInfo = env.languageService.getCompletionsAtPosition(FILE_NAME, tsPos, {}, {});

			if (!completionInfo) return null;

			const options = completionInfo.entries
				.filter(
					(entry) =>
						!TS_COMPLETE_BLOCKLIST.includes(entry.kind) &&
						(entry.sortText < '15' || completionInfo.optionalReplacementSpan?.length),
				)
				.map((entry): Completion => {
					const boost = -Number(entry.sortText) || 0;
					return {
						label: entry.name,
						boost,
					};
				});

			return {
				from: pos,
				options,
			};
		},
		getDiagnostics() {
			const exists = env.getSourceFile(FILE_NAME);
			if (!exists) return [];

			const tsDiagnostics = [
				...env.languageService.getSemanticDiagnostics(FILE_NAME),
				...env.languageService.getSyntacticDiagnostics(FILE_NAME),
			];

			const diagnostics = tsDiagnostics.filter((diagnostic): diagnostic is DiagnosticWithLocation =>
				isDiagnosticWithLocation(diagnostic),
			);

			return diagnostics.map((d) => convertTSDiagnosticToCM(d, fnPrefix(returnTypeForMode(mode))));
		},
		getHoverTooltip(pos) {
			const tsPos = cmPosToTs(pos, fnPrefix(returnTypeForMode(mode)));
			const quickInfo = env.languageService.getQuickInfoAtPosition(FILE_NAME, tsPos);

			if (!quickInfo) return null;

			const start = tsPosToCm(quickInfo.textSpan.start, fnPrefix(returnTypeForMode(mode)));

			const typeDef =
				env.languageService.getTypeDefinitionAtPosition(FILE_NAME, tsPos) ??
				env.languageService.getDefinitionAtPosition(FILE_NAME, tsPos);

			return {
				start,
				end: start + quickInfo.textSpan.length,
				typeDef,
				quickInfo,
			};
		},
		async updateMode(newMode) {
			mode = newMode;
			updateFile(
				'n8n-mode-specific.d.ts',
				mode === 'runOnceForAllItems' ? runOnceForAllItemsTypes : runOnceForEachItemTypes,
			);
			await Promise.all(
				inputNodeNames.map(async (nodeName) => await setInputNodeTypes(nodeName, mode)),
			);
		},
		async updateNodeTypes() {
			const nodeNames = Object.keys(loadedNodeTypesMap);

			console.log('nodes to load', nodeNames);
			await Promise.all(nodeNames.map(async (nodeName) => await loadNodeTypes(nodeName)));
			await Promise.all(
				inputNodeNames.map(async (nodeName) => await setInputNodeTypes(nodeName, mode)),
			);
		},
	};
};

Comlink.expose(worker());
