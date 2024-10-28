import type {
	ICredentialDataDecryptedObject,
	IGetNodeParameterOptions,
	INode,
	INodeExecutionData,
	IExecuteFunctions,
	IRunExecutionData,
	IWorkflowExecuteAdditionalData,
	Workflow,
	WorkflowExecuteMode,
	CloseFunction,
	IExecuteData,
	ITaskDataConnections,
	CallbackManager,
	IExecuteWorkflowInfo,
	ContextType,
	IContextObject,
	NodeConnectionType,
	INodeInputConfiguration,
	INodeOutputConfiguration,
	IWorkflowDataProxyData,
	IExecuteResponsePromiseData,
	ExecutionBaseError,
	AiEvent,
	DeduplicationHelperFunctions,
	FileSystemHelperFunctions,
} from 'n8n-workflow';
import {
	ApplicationError,
	createDeferredPromise,
	NodeHelpers,
	WorkflowDataProxy,
} from 'n8n-workflow';

import {
	addExecutionDataFunctions,
	assertBinaryData,
	constructExecutionMetaData,
	continueOnFail,
	copyBinaryFile,
	copyInputItems,
	getAdditionalKeys,
	getBinaryDataBuffer,
	getCredentials,
	getInputConnectionData,
	getNodeParameter,
	normalizeItems,
	returnJsonArray,
} from '@/NodeExecuteFunctions';
import { BaseContext } from './base-contexts';
import { RequestHelpers } from './helpers/request-helpers';
import { BinaryDataService } from '@/BinaryData/BinaryData.service';
import Container from 'typedi';
import { BinaryHelpers } from './helpers/binary-helpers';
import { createAgentStartJob } from '@/Agent';
import { SSHTunnelHelpers } from './helpers/ssh-tunnel-helpers';
import { DeduplicationHelpers } from './helpers/deduplication-helpers';
import { FileSystemHelpers } from './helpers/file-system-helpers';

export class ExecutionContext extends BaseContext implements IExecuteFunctions {
	readonly helpers: IExecuteFunctions['helpers'];
	readonly nodeHelpers: IExecuteFunctions['nodeHelpers'];
	readonly startJob: IExecuteFunctions['startJob'];

	private readonly binaryDataService = Container.get(BinaryDataService);

	constructor(
		workflow: Workflow,
		node: INode,
		additionalData: IWorkflowExecuteAdditionalData,
		private readonly mode: WorkflowExecuteMode,
		private readonly runExecutionData: IRunExecutionData,
		private readonly runIndex: number,
		private readonly connectionInputData: INodeExecutionData[],
		private readonly inputData: ITaskDataConnections,
		private readonly executeData: IExecuteData,
		private readonly closeFunctions: CloseFunction[],
		private readonly abortSignal?: AbortSignal,
	) {
		super(workflow, node, additionalData);

		const binaryHelpers = new BinaryHelpers(workflow, additionalData);
		const deduplicationHelpers = new DeduplicationHelpers(workflow, node);
		const fileSystemHelpers = new FileSystemHelpers(node);
		const requestHelpers = new RequestHelpers(
			this as IExecuteFunctions,
			workflow,
			node,
			additionalData,
		);
		const sshTunnelHelpers = new SSHTunnelHelpers();

		// TODO: extract out in a BaseExecutionContext
		this.helpers = {
			createDeferredPromise,
			returnJsonArray,

			getBinaryPath: (id) => binaryHelpers.getBinaryPath(id),
			getBinaryMetadata: (id) => binaryHelpers.getBinaryMetadata(id),
			getBinaryStream: (id) => binaryHelpers.getBinaryStream(id),
			binaryToBuffer: (body) => binaryHelpers.binaryToBuffer(body),
			binaryToString: (body) => binaryHelpers.binaryToString(body),
			prepareBinaryData: binaryHelpers.prepareBinaryData.bind(binaryHelpers),
			setBinaryDataBuffer: binaryHelpers.setBinaryDataBuffer.bind(binaryHelpers),
			copyBinaryFile: () => binaryHelpers.copyBinaryFile(),
			assertBinaryData: (itemIndex, propertyName) =>
				assertBinaryData(inputData, node, itemIndex, propertyName, 0),
			getBinaryDataBuffer: async (itemIndex, propertyName) =>
				await getBinaryDataBuffer(inputData, itemIndex, propertyName, 0),

			httpRequest: requestHelpers.httpRequest.bind(requestHelpers),
			httpRequestWithAuthentication:
				requestHelpers.httpRequestWithAuthentication.bind(requestHelpers),
			requestWithAuthenticationPaginated:
				requestHelpers.requestWithAuthenticationPaginated.bind(requestHelpers),
			request: requestHelpers.request.bind(requestHelpers),
			requestWithAuthentication: requestHelpers.requestWithAuthentication.bind(requestHelpers),
			requestOAuth1: requestHelpers.requestOAuth1.bind(requestHelpers),
			requestOAuth2: requestHelpers.requestOAuth2.bind(requestHelpers),

			getSSHClient: sshTunnelHelpers.getSSHClient.bind(sshTunnelHelpers),

			copyInputItems,
			normalizeItems,
			constructExecutionMetaData,

			checkProcessedAndRecord:
				deduplicationHelpers.checkProcessedAndRecord.bind(deduplicationHelpers),
			checkProcessedItemsAndRecord:
				deduplicationHelpers.checkProcessedItemsAndRecord.bind(deduplicationHelpers),
			removeProcessed: deduplicationHelpers.removeProcessed.bind(deduplicationHelpers),
			clearAllProcessedItems:
				deduplicationHelpers.clearAllProcessedItems.bind(deduplicationHelpers),
			getProcessedDataCount: deduplicationHelpers.getProcessedDataCount.bind(deduplicationHelpers),

			createReadStream: fileSystemHelpers.createReadStream.bind(fileSystemHelpers),
			getStoragePath: fileSystemHelpers.getStoragePath.bind(fileSystemHelpers),
			writeContentToFile: fileSystemHelpers.writeContentToFile.bind(fileSystemHelpers),
		};

		this.nodeHelpers = {
			copyBinaryFile: async (filePath, fileName, mimeType) =>
				await copyBinaryFile(
					this.workflow.id,
					this.additionalData.executionId!,
					filePath,
					fileName,
					mimeType,
				),
		};

		this.startJob = createAgentStartJob(
			additionalData,
			inputData,
			node,
			workflow,
			runExecutionData,
			runIndex,
			node.name,
			connectionInputData,
			{},
			mode,
			executeData,
		);
	}

	getMode() {
		return this.mode;
	}

	// TODO: extract out in a BaseExecutionContext
	getExecutionCancelSignal() {
		return this.abortSignal;
	}

	// TODO: extract out in a BaseExecutionContext
	onExecutionCancellation(handler: () => unknown) {
		const fn = () => {
			this.abortSignal?.removeEventListener('abort', fn);
			handler();
		};
		this.abortSignal?.addEventListener('abort', fn);
	}

	// TODO: This is identical to PollContext
	async getCredentials<T extends object = ICredentialDataDecryptedObject>(
		type: string,
		itemIndex?: number,
	) {
		return await getCredentials<T>(
			this.workflow,
			this.node,
			type,
			this.additionalData,
			this.mode,
			this.executeData,
			this.runExecutionData,
			this.runIndex,
			this.connectionInputData,
			itemIndex,
		);
	}

	getExecuteData() {
		return this.executeData;
	}

	continueOnFail() {
		return continueOnFail(this.node);
	}

	// TODO: Move to BaseContext
	evaluateExpression(expression: string, itemIndex: number) {
		return this.workflow.expression.resolveSimpleParameterValue(
			`=${expression}`,
			{},
			this.runExecutionData,
			this.runIndex,
			itemIndex,
			// TODO: revert this back to `node.name` when we stop using `IExecuteFunctions` as the context object in AI nodes.
			// https://linear.app/n8n/issue/CAT-269
			this.node.name,
			this.connectionInputData,
			this.mode,
			getAdditionalKeys(this.additionalData, this.mode, this.runExecutionData),
			this.executeData,
		);
	}

	async executeWorkflow(
		workflowInfo: IExecuteWorkflowInfo,
		inputData?: INodeExecutionData[],
		parentCallbackManager?: CallbackManager,
	): Promise<any> {
		return await this.additionalData
			.executeWorkflow(workflowInfo, this.additionalData, {
				parentWorkflowId: this.workflow.id?.toString(),
				inputData,
				parentWorkflowSettings: this.workflow.settings,
				node: this.node,
				parentCallbackManager,
			})
			.then(
				async (result) =>
					await this.binaryDataService.duplicateBinaryData(
						this.workflow.id,
						this.additionalData.executionId!,
						result,
					),
			);
	}

	// TODO: Move to BaseExecutionContext
	getContext(type: ContextType): IContextObject {
		return NodeHelpers.getContext(this.runExecutionData, type, this.node);
	}

	async getInputConnectionData(inputName: NodeConnectionType, itemIndex: number): Promise<unknown> {
		// TODO: trim down the function signature
		return await getInputConnectionData(
			this as IExecuteFunctions,
			this.workflow,
			this.runExecutionData,
			this.runIndex,
			this.connectionInputData,
			this.inputData,
			this.additionalData,
			this.executeData,
			this.mode,
			this.closeFunctions,
			inputName,
			itemIndex,
		);
	}

	getNodeInputs(): INodeInputConfiguration[] {
		const nodeType = this.workflow.nodeTypes.getByNameAndVersion(
			this.node.type,
			this.node.typeVersion,
		);
		// TODO: move NodeHelpers.getNodeInputs here (if possible)
		return NodeHelpers.getNodeInputs(this.workflow, this.node, nodeType.description).map(
			(output) => {
				if (typeof output === 'string') {
					return {
						type: output,
					};
				}
				return output;
			},
		);
	}

	getNodeOutputs(): INodeOutputConfiguration[] {
		const nodeType = this.workflow.nodeTypes.getByNameAndVersion(
			this.node.type,
			this.node.typeVersion,
		);
		return NodeHelpers.getNodeOutputs(this.workflow, this.node, nodeType.description).map(
			(output) => {
				if (typeof output === 'string') {
					return {
						type: output,
					};
				}
				return output;
			},
		);
	}

	getInputData(inputIndex = 0, inputName = 'main') {
		if (!this.inputData.hasOwnProperty(inputName)) {
			// Return empty array because else it would throw error when nothing is connected to input
			return [];
		}

		// TODO: Check if nodeType has input with that index defined
		if (this.inputData[inputName].length < inputIndex) {
			throw new ApplicationError('Could not get input with given index', {
				extra: { inputIndex, inputName },
			});
		}

		if (this.inputData[inputName][inputIndex] === null) {
			throw new ApplicationError('Value of input was not set', {
				extra: { inputIndex, inputName },
			});
		}

		return this.inputData[inputName][inputIndex];
	}

	getInputSourceData(inputIndex = 0, inputName = 'main') {
		if (this.executeData?.source === null) {
			// Should never happen as n8n sets it automatically
			throw new ApplicationError('Source data is missing');
		}
		return this.executeData.source[inputName][inputIndex]!;
	}

	// TODO: Move to BaseContext
	// @ts-expect-error Not sure how to fix this typing
	getNodeParameter(
		parameterName: string,
		itemIndex: number,
		fallbackValue?: any,
		options?: IGetNodeParameterOptions,
	) {
		return getNodeParameter(
			this.workflow,
			this.runExecutionData,
			this.runIndex,
			this.connectionInputData,
			this.node,
			parameterName,
			itemIndex,
			this.mode,
			getAdditionalKeys(this.additionalData, this.mode, this.runExecutionData),
			this.executeData,
			fallbackValue,
			options,
		);
	}

	// TODO: Move to BaseExecutionContext
	getWorkflowDataProxy(itemIndex: number): IWorkflowDataProxyData {
		const dataProxy = new WorkflowDataProxy(
			this.workflow,
			this.runExecutionData,
			this.runIndex,
			itemIndex,
			this.node.name,
			this.connectionInputData,
			{},
			this.mode,
			getAdditionalKeys(this.additionalData, this.mode, this.runExecutionData),
			this.executeData,
		);
		return dataProxy.getDataProxy();
	}

	async putExecutionToWait(waitTill: Date): Promise<void> {
		this.runExecutionData.waitTill = waitTill;
		if (this.additionalData.setExecutionStatus) {
			this.additionalData.setExecutionStatus('waiting');
		}
	}

	logNodeOutput(...args: unknown[]): void {
		if (this.mode === 'manual') {
			this.sendMessageToUI(...args);
			return;
		}

		if (process.env.CODE_ENABLE_STDOUT === 'true') {
			console.log(`[Workflow "${this.workflow.id}"][Node "${this.node.name}"]`, ...args);
		}
	}

	sendMessageToUI(...args: any[]): void {
		if (this.mode !== 'manual') {
			return;
		}

		try {
			if (this.additionalData.sendDataToUI) {
				args = args.map((arg) => {
					// prevent invalid dates from being logged as null
					if (arg.isLuxonDateTime && arg.invalidReason) return { ...arg };

					// log valid dates in human readable format, as in browser
					if (arg.isLuxonDateTime) return new Date(arg.ts).toString();
					if (arg instanceof Date) return arg.toString();

					return arg;
				});

				this.additionalData.sendDataToUI('sendConsoleMessage', {
					source: `[Node: "${this.node.name}"]`,
					messages: args,
				});
			}
		} catch (error) {
			this.logger.warn(`There was a problem sending message to UI: ${error.message}`);
		}
	}

	async sendResponse(response: IExecuteResponsePromiseData): Promise<void> {
		await this.additionalData.hooks?.executeHookFunctions('sendResponse', [response]);
	}

	addInputData(
		connectionType: NodeConnectionType,
		data: INodeExecutionData[][] | ExecutionBaseError,
	): { index: number } {
		const nodeName = this.node.name;
		let currentNodeRunIndex = 0;
		if (this.runExecutionData.resultData.runData.hasOwnProperty(nodeName)) {
			currentNodeRunIndex = this.runExecutionData.resultData.runData[nodeName].length;
		}

		addExecutionDataFunctions(
			'input',
			this.node.name,
			data,
			this.runExecutionData,
			connectionType,
			this.additionalData,
			this.node.name,
			this.runIndex,
			currentNodeRunIndex,
		).catch((error) => {
			this.logger.warn(
				`There was a problem logging input data of node "${this.node.name}": ${error.message}`,
			);
		});

		return { index: currentNodeRunIndex };
	}

	addOutputData(
		connectionType: NodeConnectionType,
		currentNodeRunIndex: number,
		data: INodeExecutionData[][] | ExecutionBaseError,
	): void {
		addExecutionDataFunctions(
			'output',
			this.node.name,
			data,
			this.runExecutionData,
			connectionType,
			this.additionalData,
			this.node.name,
			this.runIndex,
			currentNodeRunIndex,
		).catch((error) => {
			this.logger.warn(
				`There was a problem logging output data of node "${this.node.name}": ${error.message}`,
			);
		});
	}

	logAiEvent(eventName: AiEvent, msg: string) {
		return this.additionalData.logAiEvent(eventName, {
			executionId: this.additionalData.executionId ?? 'unsaved-execution',
			nodeName: this.node.name,
			workflowName: this.workflow.name ?? 'Unnamed workflow',
			nodeType: this.node.type,
			workflowId: this.workflow.id ?? 'unsaved-workflow',
			msg,
		});
	}

	getParentCallbackManager(): CallbackManager | undefined {
		return this.additionalData.parentCallbackManager;
	}
}