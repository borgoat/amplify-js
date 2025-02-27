// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Observable, SubscriptionLike } from 'rxjs';
import { GraphQLError } from 'graphql';
import {
	Hub,
	fetchAuthSession,
	ConsoleLogger,
	HubPayload,
} from '@aws-amplify/core';
import { signRequest } from '@aws-amplify/core/internals/aws-client-utils';
import {
	base64Encoder,
	GraphQLAuthMode,
	CustomUserAgentDetails,
	NonRetryableError,
	USER_AGENT_HEADER,
	getAmplifyUserAgent,
	isNonRetryableError,
	jitteredExponentialRetry,
	DocumentType,
	amplifyUuid,
	AmplifyUrl,
} from '@aws-amplify/core/internals/utils';

import {
	CONTROL_MSG,
	ConnectionState,
	PubSubContentObserver,
} from '../../types/PubSub';
import {
	AMPLIFY_SYMBOL,
	AWS_APPSYNC_REALTIME_HEADERS,
	CONNECTION_INIT_TIMEOUT,
	DEFAULT_KEEP_ALIVE_TIMEOUT,
	DEFAULT_KEEP_ALIVE_ALERT_TIMEOUT,
	MAX_DELAY_MS,
	MESSAGE_TYPES,
	NON_RETRYABLE_CODES,
	SOCKET_STATUS,
	START_ACK_TIMEOUT,
	SUBSCRIPTION_STATUS,
	CONNECTION_STATE_CHANGE,
} from '../constants';
import {
	ConnectionStateMonitor,
	CONNECTION_CHANGE,
} from '../../utils/ConnectionStateMonitor';
import {
	ReconnectEvent,
	ReconnectionMonitor,
} from '../../utils/ReconnectionMonitor';
import { CustomHeaders, RequestOptions } from '@aws-amplify/data-schema-types';

const logger = new ConsoleLogger('AWSAppSyncRealTimeProvider');

const dispatchApiEvent = (payload: HubPayload) => {
	Hub.dispatch('api', payload, 'PubSub', AMPLIFY_SYMBOL);
};

export type ObserverQuery = {
	observer: PubSubContentObserver;
	query: string;
	variables: Record<string, DocumentType>;
	subscriptionState: SUBSCRIPTION_STATUS;
	subscriptionReadyCallback?: Function;
	subscriptionFailedCallback?: Function;
	startAckTimeoutId?: ReturnType<typeof setTimeout>;
};

const standardDomainPattern =
	/^https:\/\/\w{26}\.appsync\-api\.\w{2}(?:(?:\-\w{2,})+)\-\d\.amazonaws.com(?:\.cn)?\/graphql$/i;

const customDomainPath = '/realtime';

type DataObject = {
	data: Record<string, unknown>;
};

type DataPayload = {
	id: string;
	payload: DataObject;
	type: string;
};

type ParsedMessagePayload = {
	type: string;
	payload: {
		connectionTimeoutMs: number;
		errors?: [{ errorType: string; errorCode: number }];
	};
};

export interface AWSAppSyncRealTimeProviderOptions {
	appSyncGraphqlEndpoint?: string;
	authenticationType?: GraphQLAuthMode;
	query?: string;
	variables?: Record<string, DocumentType>;
	apiKey?: string;
	region?: string;
	libraryConfigHeaders?: () => {} | (() => Promise<{}>);
	additionalHeaders?: CustomHeaders;
	additionalCustomHeaders?: Record<string, string>;
	authToken?: string;
}

type AWSAppSyncRealTimeAuthInput =
	Partial<AWSAppSyncRealTimeProviderOptions> & {
		canonicalUri: string;
		payload: string;
		host?: string | undefined;
	};

export class AWSAppSyncRealTimeProvider {
	private awsRealTimeSocket?: WebSocket;
	private socketStatus: SOCKET_STATUS = SOCKET_STATUS.CLOSED;
	private keepAliveTimeoutId?: ReturnType<typeof setTimeout>;
	private keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT;
	private keepAliveAlertTimeoutId?: ReturnType<typeof setTimeout>;
	private subscriptionObserverMap: Map<string, ObserverQuery> = new Map();
	private promiseArray: Array<{ res: Function; rej: Function }> = [];
	private connectionState: ConnectionState | undefined;
	private readonly connectionStateMonitor = new ConnectionStateMonitor();
	private readonly reconnectionMonitor = new ReconnectionMonitor();
	private connectionStateMonitorSubscription: SubscriptionLike;

	constructor(options: AWSAppSyncRealTimeProviderOptions = {}) {
		// Monitor the connection state and pass changes along to Hub
		this.connectionStateMonitorSubscription =
			this.connectionStateMonitor.connectionStateObservable.subscribe(
				connectionState => {
					dispatchApiEvent({
						event: CONNECTION_STATE_CHANGE,
						data: {
							provider: this,
							connectionState,
						},
						message: `Connection state is ${connectionState}`,
					});
					this.connectionState = connectionState;

					// Trigger START_RECONNECT when the connection is disrupted
					if (connectionState === ConnectionState.ConnectionDisrupted) {
						this.reconnectionMonitor.record(ReconnectEvent.START_RECONNECT);
					}

					// Trigger HALT_RECONNECT to halt reconnection attempts when the state is anything other than
					//   ConnectionDisrupted or Connecting
					if (
						[
							ConnectionState.Connected,
							ConnectionState.ConnectedPendingDisconnect,
							ConnectionState.ConnectedPendingKeepAlive,
							ConnectionState.ConnectedPendingNetwork,
							ConnectionState.ConnectionDisruptedPendingNetwork,
							ConnectionState.Disconnected,
						].includes(connectionState)
					) {
						this.reconnectionMonitor.record(ReconnectEvent.HALT_RECONNECT);
					}
				}
			);
	}

	/**
	 * Mark the socket closed and release all active listeners
	 */
	close() {
		// Mark the socket closed both in status and the connection monitor
		this.socketStatus = SOCKET_STATUS.CLOSED;
		this.connectionStateMonitor.record(CONNECTION_CHANGE.CONNECTION_FAILED);

		// Turn off the subscription monitor Hub publishing
		this.connectionStateMonitorSubscription.unsubscribe();
		// Complete all reconnect observers
		this.reconnectionMonitor.close();
	}

	getNewWebSocket(url: string, protocol: string) {
		return new WebSocket(url, protocol);
	}

	getProviderName() {
		return 'AWSAppSyncRealTimeProvider';
	}

	// Check if url matches standard domain pattern
	private isCustomDomain(url: string): boolean {
		return url.match(standardDomainPattern) === null;
	}

	subscribe(
		options?: AWSAppSyncRealTimeProviderOptions,
		customUserAgentDetails?: CustomUserAgentDetails
	): Observable<Record<string, unknown>> {
		const {
			appSyncGraphqlEndpoint,
			region,
			query,
			variables,
			authenticationType,
			additionalHeaders,
			apiKey,
			authToken,
			libraryConfigHeaders,
		} = options || {};

		return new Observable(observer => {
			if (!options || !appSyncGraphqlEndpoint) {
				observer.error({
					errors: [
						{
							...new GraphQLError(
								`Subscribe only available for AWS AppSync endpoint`
							),
						},
					],
				});
				observer.complete();
			} else {
				let subscriptionStartActive = false;
				const subscriptionId = amplifyUuid();
				const startSubscription = () => {
					if (!subscriptionStartActive) {
						subscriptionStartActive = true;

						const startSubscriptionPromise =
							this._startSubscriptionWithAWSAppSyncRealTime({
								options: {
									query,
									variables,
									region,
									authenticationType,
									appSyncGraphqlEndpoint,
									additionalHeaders,
									apiKey,
									authToken,
									libraryConfigHeaders,
								},
								observer,
								subscriptionId,
								customUserAgentDetails,
							}).catch<any>(err => {
								logger.debug(
									`${CONTROL_MSG.REALTIME_SUBSCRIPTION_INIT_ERROR}: ${err}`
								);

								this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSED);
							});
						startSubscriptionPromise.finally(() => {
							subscriptionStartActive = false;
						});
					}
				};

				let reconnectSubscription: SubscriptionLike;

				// Add an observable to the reconnection list to manage reconnection for this subscription
				reconnectSubscription = new Observable(observer => {
					this.reconnectionMonitor.addObserver(observer);
				}).subscribe(() => {
					startSubscription();
				});

				startSubscription();

				return async () => {
					// Cleanup reconnection subscription
					reconnectSubscription?.unsubscribe();

					// Cleanup after unsubscribing or observer.complete was called after _startSubscriptionWithAWSAppSyncRealTime
					try {
						// Waiting that subscription has been connected before trying to unsubscribe
						await this._waitForSubscriptionToBeConnected(subscriptionId);

						const { subscriptionState } =
							this.subscriptionObserverMap.get(subscriptionId) || {};

						if (!subscriptionState) {
							// subscription already unsubscribed
							return;
						}

						if (subscriptionState === SUBSCRIPTION_STATUS.CONNECTED) {
							this._sendUnsubscriptionMessage(subscriptionId);
						} else {
							throw new Error('Subscription never connected');
						}
					} catch (err) {
						logger.debug(`Error while unsubscribing ${err}`);
					} finally {
						this._removeSubscriptionObserver(subscriptionId);
					}
				};
			}
		});
	}

	private async _startSubscriptionWithAWSAppSyncRealTime({
		options,
		observer,
		subscriptionId,
		customUserAgentDetails,
	}: {
		options: AWSAppSyncRealTimeProviderOptions;
		observer: PubSubContentObserver;
		subscriptionId: string;
		customUserAgentDetails: CustomUserAgentDetails | undefined;
	}) {
		const {
			appSyncGraphqlEndpoint,
			authenticationType,
			query,
			variables,
			apiKey,
			region,
			libraryConfigHeaders = () => ({}),
			additionalHeaders = {},
			authToken,
		} = options;

		let additionalCustomHeaders: Record<string, string> = {};

		if (typeof additionalHeaders === 'function') {
			const requestOptions: RequestOptions = {
				url: appSyncGraphqlEndpoint || '',
				queryString: query || '',
			};
			additionalCustomHeaders = await additionalHeaders(requestOptions);
		} else {
			additionalCustomHeaders = additionalHeaders;
		}

		// if an authorization header is set, have the explicit authToken take precedence
		if (authToken) {
			additionalCustomHeaders = {
				...additionalCustomHeaders,
				Authorization: authToken,
			};
		}

		const subscriptionState: SUBSCRIPTION_STATUS = SUBSCRIPTION_STATUS.PENDING;
		const data = {
			query,
			variables,
		};
		// Having a subscription id map will make it simple to forward messages received
		this.subscriptionObserverMap.set(subscriptionId, {
			observer,
			query: query ?? '',
			variables: variables ?? {},
			subscriptionState,
			startAckTimeoutId: undefined,
		});

		// Preparing payload for subscription message

		const dataString = JSON.stringify(data);
		const headerObj = {
			...(await this._awsRealTimeHeaderBasedAuth({
				apiKey,
				appSyncGraphqlEndpoint,
				authenticationType,
				payload: dataString,
				canonicalUri: '',
				region,
				additionalCustomHeaders,
			})),
			...(await libraryConfigHeaders()),
			...additionalCustomHeaders,
			[USER_AGENT_HEADER]: getAmplifyUserAgent(customUserAgentDetails),
		};

		const subscriptionMessage = {
			id: subscriptionId,
			payload: {
				data: dataString,
				extensions: {
					authorization: {
						...headerObj,
					},
				},
			},
			type: MESSAGE_TYPES.GQL_START,
		};

		const stringToAWSRealTime = JSON.stringify(subscriptionMessage);

		try {
			this.connectionStateMonitor.record(CONNECTION_CHANGE.OPENING_CONNECTION);
			await this._initializeWebSocketConnection({
				apiKey,
				appSyncGraphqlEndpoint,
				authenticationType,
				region,
				additionalCustomHeaders,
			});
		} catch (err: any) {
			this._logStartSubscriptionError(subscriptionId, observer, err);
			return;
		}

		// Potential race condition can occur when unsubscribe is called during _initializeWebSocketConnection.
		// E.g.unsubscribe gets invoked prior to finishing WebSocket handshake or START_ACK.
		// Both subscriptionFailedCallback and subscriptionReadyCallback are used to synchronized this.

		const { subscriptionFailedCallback, subscriptionReadyCallback } =
			this.subscriptionObserverMap.get(subscriptionId) ?? {};

		// This must be done before sending the message in order to be listening immediately
		this.subscriptionObserverMap.set(subscriptionId, {
			observer,
			subscriptionState,
			query: query ?? '',
			variables: variables ?? {},
			subscriptionReadyCallback,
			subscriptionFailedCallback,
			startAckTimeoutId: setTimeout(() => {
				this._timeoutStartSubscriptionAck.call(this, subscriptionId);
			}, START_ACK_TIMEOUT),
		});
		if (this.awsRealTimeSocket) {
			this.awsRealTimeSocket.send(stringToAWSRealTime);
		}
	}

	// Log logic for start subscription failures
	private _logStartSubscriptionError(
		subscriptionId: string,
		observer: PubSubContentObserver,
		err: { message?: string }
	) {
		logger.debug({ err });
		const message = String(err.message ?? '');
		// Resolving to give the state observer time to propogate the update
		Promise.resolve(
			this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSED)
		);

		// Capture the error only when the network didn't cause disruption
		if (
			this.connectionState !== ConnectionState.ConnectionDisruptedPendingNetwork
		) {
			// When the error is non-retriable, error out the observable
			if (isNonRetryableError(err)) {
				observer.error({
					errors: [
						{
							...new GraphQLError(
								`${CONTROL_MSG.CONNECTION_FAILED}: ${message}`
							),
						},
					],
				});
			} else {
				logger.debug(`${CONTROL_MSG.CONNECTION_FAILED}: ${message}`);
			}

			const { subscriptionFailedCallback } =
				this.subscriptionObserverMap.get(subscriptionId) || {};

			// Notify concurrent unsubscription
			if (typeof subscriptionFailedCallback === 'function') {
				subscriptionFailedCallback();
			}
		}
	}

	// Waiting that subscription has been connected before trying to unsubscribe
	private async _waitForSubscriptionToBeConnected(subscriptionId: string) {
		const subscriptionObserver =
			this.subscriptionObserverMap.get(subscriptionId);
		if (subscriptionObserver) {
			const { subscriptionState } = subscriptionObserver;
			// This in case unsubscribe is invoked before sending start subscription message
			if (subscriptionState === SUBSCRIPTION_STATUS.PENDING) {
				return new Promise((res, rej) => {
					const { observer, subscriptionState, variables, query } =
						subscriptionObserver;
					this.subscriptionObserverMap.set(subscriptionId, {
						observer,
						subscriptionState,
						variables,
						query,
						subscriptionReadyCallback: res,
						subscriptionFailedCallback: rej,
					});
				});
			}
		}
	}

	private _sendUnsubscriptionMessage(subscriptionId: string) {
		try {
			if (
				this.awsRealTimeSocket &&
				this.awsRealTimeSocket.readyState === WebSocket.OPEN &&
				this.socketStatus === SOCKET_STATUS.READY
			) {
				// Preparing unsubscribe message to stop receiving messages for that subscription
				const unsubscribeMessage = {
					id: subscriptionId,
					type: MESSAGE_TYPES.GQL_STOP,
				};
				const stringToAWSRealTime = JSON.stringify(unsubscribeMessage);
				this.awsRealTimeSocket.send(stringToAWSRealTime);
			}
		} catch (err) {
			// If GQL_STOP is not sent because of disconnection issue, then there is nothing the client can do
			logger.debug({ err });
		}
	}

	private _removeSubscriptionObserver(subscriptionId: string) {
		this.subscriptionObserverMap.delete(subscriptionId);

		// Verifying 1000ms after removing subscription in case there are new subscription unmount/mount
		setTimeout(this._closeSocketIfRequired.bind(this), 1000);
	}

	private _closeSocketIfRequired() {
		if (this.subscriptionObserverMap.size > 0) {
			// Active subscriptions on the WebSocket
			return;
		}

		if (!this.awsRealTimeSocket) {
			this.socketStatus = SOCKET_STATUS.CLOSED;
			return;
		}

		this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSING_CONNECTION);

		if (this.awsRealTimeSocket.bufferedAmount > 0) {
			// Still data on the WebSocket
			setTimeout(this._closeSocketIfRequired.bind(this), 1000);
		} else {
			logger.debug('closing WebSocket...');
			if (this.keepAliveTimeoutId) {
				clearTimeout(this.keepAliveTimeoutId);
			}
			if (this.keepAliveAlertTimeoutId) {
				clearTimeout(this.keepAliveAlertTimeoutId);
			}
			const tempSocket = this.awsRealTimeSocket;
			// Cleaning callbacks to avoid race condition, socket still exists
			tempSocket.onclose = null;
			tempSocket.onerror = null;
			tempSocket.close(1000);
			this.awsRealTimeSocket = undefined;
			this.socketStatus = SOCKET_STATUS.CLOSED;
			this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSED);
		}
	}

	private _handleIncomingSubscriptionMessage(message: MessageEvent) {
		if (typeof message.data !== 'string') {
			return;
		}
		logger.debug(
			`subscription message from AWS AppSync RealTime: ${message.data}`
		);
		const {
			id = '',
			payload,
			type,
		}: DataPayload = JSON.parse(String(message.data));
		const {
			observer = null,
			query = '',
			variables = {},
			startAckTimeoutId,
			subscriptionReadyCallback,
			subscriptionFailedCallback,
		} = this.subscriptionObserverMap.get(id) || {};

		logger.debug({ id, observer, query, variables });

		if (type === MESSAGE_TYPES.GQL_DATA && payload && payload.data) {
			if (observer) {
				observer.next(payload);
			} else {
				logger.debug(`observer not found for id: ${id}`);
			}
			return;
		}

		if (type === MESSAGE_TYPES.GQL_START_ACK) {
			logger.debug(
				`subscription ready for ${JSON.stringify({ query, variables })}`
			);
			if (typeof subscriptionReadyCallback === 'function') {
				subscriptionReadyCallback();
			}
			if (startAckTimeoutId) clearTimeout(startAckTimeoutId);
			dispatchApiEvent({
				event: CONTROL_MSG.SUBSCRIPTION_ACK,
				data: { query, variables },
				message: 'Connection established for subscription',
			});
			const subscriptionState = SUBSCRIPTION_STATUS.CONNECTED;
			if (observer) {
				this.subscriptionObserverMap.set(id, {
					observer,
					query,
					variables,
					startAckTimeoutId: undefined,
					subscriptionState,
					subscriptionReadyCallback,
					subscriptionFailedCallback,
				});
			}
			this.connectionStateMonitor.record(
				CONNECTION_CHANGE.CONNECTION_ESTABLISHED
			);

			return;
		}

		if (type === MESSAGE_TYPES.GQL_CONNECTION_KEEP_ALIVE) {
			if (this.keepAliveTimeoutId) clearTimeout(this.keepAliveTimeoutId);
			if (this.keepAliveAlertTimeoutId)
				clearTimeout(this.keepAliveAlertTimeoutId);
			this.keepAliveTimeoutId = setTimeout(
				() => this._errorDisconnect(CONTROL_MSG.TIMEOUT_DISCONNECT),
				this.keepAliveTimeout
			);
			this.keepAliveAlertTimeoutId = setTimeout(() => {
				this.connectionStateMonitor.record(CONNECTION_CHANGE.KEEP_ALIVE_MISSED);
			}, DEFAULT_KEEP_ALIVE_ALERT_TIMEOUT);
			this.connectionStateMonitor.record(CONNECTION_CHANGE.KEEP_ALIVE);
			return;
		}

		if (type === MESSAGE_TYPES.GQL_ERROR) {
			const subscriptionState = SUBSCRIPTION_STATUS.FAILED;
			if (observer) {
				this.subscriptionObserverMap.set(id, {
					observer,
					query,
					variables,
					startAckTimeoutId,
					subscriptionReadyCallback,
					subscriptionFailedCallback,
					subscriptionState,
				});

				logger.debug(
					`${CONTROL_MSG.CONNECTION_FAILED}: ${JSON.stringify(payload)}`
				);

				observer.error({
					errors: [
						{
							...new GraphQLError(
								`${CONTROL_MSG.CONNECTION_FAILED}: ${JSON.stringify(payload)}`
							),
						},
					],
				});

				if (startAckTimeoutId) clearTimeout(startAckTimeoutId);

				if (typeof subscriptionFailedCallback === 'function') {
					subscriptionFailedCallback();
				}
			}
		}
	}

	private _errorDisconnect(msg: string) {
		logger.debug(`Disconnect error: ${msg}`);

		if (this.awsRealTimeSocket) {
			this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSED);
			this.awsRealTimeSocket.close();
		}

		this.socketStatus = SOCKET_STATUS.CLOSED;
	}

	private _timeoutStartSubscriptionAck(subscriptionId: string) {
		const subscriptionObserver =
			this.subscriptionObserverMap.get(subscriptionId);
		if (subscriptionObserver) {
			const { observer, query, variables } = subscriptionObserver;
			if (!observer) {
				return;
			}
			this.subscriptionObserverMap.set(subscriptionId, {
				observer,
				query,
				variables,
				subscriptionState: SUBSCRIPTION_STATUS.FAILED,
			});

			this.connectionStateMonitor.record(CONNECTION_CHANGE.CLOSED);
			logger.debug(
				'timeoutStartSubscription',
				JSON.stringify({ query, variables })
			);
		}
	}

	private _initializeWebSocketConnection({
		appSyncGraphqlEndpoint,
		authenticationType,
		apiKey,
		region,
		additionalCustomHeaders,
	}: AWSAppSyncRealTimeProviderOptions) {
		if (this.socketStatus === SOCKET_STATUS.READY) {
			return;
		}
		return new Promise(async (res, rej) => {
			this.promiseArray.push({ res, rej });

			if (this.socketStatus === SOCKET_STATUS.CLOSED) {
				try {
					this.socketStatus = SOCKET_STATUS.CONNECTING;

					const payloadString = '{}';

					const authHeader = await this._awsRealTimeHeaderBasedAuth({
						authenticationType,
						payload: payloadString,
						canonicalUri: '/connect',
						apiKey,
						appSyncGraphqlEndpoint,
						region,
						additionalCustomHeaders,
					});

					const headerString = authHeader ? JSON.stringify(authHeader) : '';
					const headerQs = base64Encoder.convert(headerString);

					const payloadQs = base64Encoder.convert(payloadString);

					let discoverableEndpoint = appSyncGraphqlEndpoint ?? '';

					if (this.isCustomDomain(discoverableEndpoint)) {
						discoverableEndpoint =
							discoverableEndpoint.concat(customDomainPath);
					} else {
						discoverableEndpoint = discoverableEndpoint
							.replace('appsync-api', 'appsync-realtime-api')
							.replace('gogi-beta', 'grt-beta');
					}

					// Creating websocket url with required query strings
					const protocol = 'wss://';
					discoverableEndpoint = discoverableEndpoint
						.replace('https://', protocol)
						.replace('http://', protocol);

					const awsRealTimeUrl = `${discoverableEndpoint}?header=${headerQs}&payload=${payloadQs}`;

					await this._initializeRetryableHandshake(awsRealTimeUrl);

					this.promiseArray.forEach(({ res }) => {
						logger.debug('Notifying connection successful');
						res();
					});
					this.socketStatus = SOCKET_STATUS.READY;
					this.promiseArray = [];
				} catch (err) {
					logger.debug('Connection exited with', err);
					this.promiseArray.forEach(({ rej }) => rej(err));
					this.promiseArray = [];
					if (
						this.awsRealTimeSocket &&
						this.awsRealTimeSocket.readyState === WebSocket.OPEN
					) {
						this.awsRealTimeSocket.close(3001);
					}
					this.awsRealTimeSocket = undefined;
					this.socketStatus = SOCKET_STATUS.CLOSED;
				}
			}
		});
	}

	private async _initializeRetryableHandshake(awsRealTimeUrl: string) {
		logger.debug(`Initializaling retryable Handshake`);
		await jitteredExponentialRetry(
			this._initializeHandshake.bind(this),
			[awsRealTimeUrl],
			MAX_DELAY_MS
		);
	}

	private async _initializeHandshake(awsRealTimeUrl: string) {
		logger.debug(`Initializing handshake ${awsRealTimeUrl}`);
		// Because connecting the socket is async, is waiting until connection is open
		// Step 1: connect websocket
		try {
			await (() => {
				return new Promise<void>((res, rej) => {
					const newSocket = this.getNewWebSocket(awsRealTimeUrl, 'graphql-ws');
					newSocket.onerror = () => {
						logger.debug(`WebSocket connection error`);
					};
					newSocket.onclose = () => {
						rej(new Error('Connection handshake error'));
					};
					newSocket.onopen = () => {
						this.awsRealTimeSocket = newSocket;
						return res();
					};
				});
			})();
			// Step 2: wait for ack from AWS AppSyncReaTime after sending init
			await (() => {
				return new Promise((res, rej) => {
					if (this.awsRealTimeSocket) {
						let ackOk = false;
						this.awsRealTimeSocket.onerror = error => {
							logger.debug(`WebSocket error ${JSON.stringify(error)}`);
						};
						this.awsRealTimeSocket.onclose = event => {
							logger.debug(`WebSocket closed ${event.reason}`);
							rej(new Error(JSON.stringify(event)));
						};

						this.awsRealTimeSocket.onmessage = (message: MessageEvent) => {
							if (typeof message.data !== 'string') {
								return;
							}
							logger.debug(
								`subscription message from AWS AppSyncRealTime: ${message.data} `
							);
							const data = JSON.parse(message.data) as ParsedMessagePayload;
							const {
								type,
								payload: {
									connectionTimeoutMs = DEFAULT_KEEP_ALIVE_TIMEOUT,
								} = {},
							} = data;
							if (type === MESSAGE_TYPES.GQL_CONNECTION_ACK) {
								ackOk = true;
								if (this.awsRealTimeSocket) {
									this.keepAliveTimeout = connectionTimeoutMs;
									this.awsRealTimeSocket.onmessage =
										this._handleIncomingSubscriptionMessage.bind(this);
									this.awsRealTimeSocket.onerror = err => {
										logger.debug(err);
										this._errorDisconnect(CONTROL_MSG.CONNECTION_CLOSED);
									};
									this.awsRealTimeSocket.onclose = event => {
										logger.debug(`WebSocket closed ${event.reason}`);
										this._errorDisconnect(CONTROL_MSG.CONNECTION_CLOSED);
									};
								}
								res('Cool, connected to AWS AppSyncRealTime');
								return;
							}

							if (type === MESSAGE_TYPES.GQL_CONNECTION_ERROR) {
								const {
									payload: {
										errors: [{ errorType = '', errorCode = 0 } = {}] = [],
									} = {},
								} = data;

								rej({ errorType, errorCode });
							}
						};

						const gqlInit = {
							type: MESSAGE_TYPES.GQL_CONNECTION_INIT,
						};
						this.awsRealTimeSocket.send(JSON.stringify(gqlInit));

						const checkAckOk = (ackOk: boolean) => {
							if (!ackOk) {
								this.connectionStateMonitor.record(
									CONNECTION_CHANGE.CONNECTION_FAILED
								);
								rej(
									new Error(
										`Connection timeout: ack from AWSAppSyncRealTime was not received after ${CONNECTION_INIT_TIMEOUT} ms`
									)
								);
							}
						};

						setTimeout(() => checkAckOk(ackOk), CONNECTION_INIT_TIMEOUT);
					}
				});
			})();
		} catch (err) {
			const { errorType, errorCode } = err as {
				errorType: string;
				errorCode: number;
			};

			if (NON_RETRYABLE_CODES.includes(errorCode)) {
				throw new NonRetryableError(errorType);
			} else if (errorType) {
				throw new Error(errorType);
			} else {
				throw err;
			}
		}
	}

	private async _awsRealTimeHeaderBasedAuth({
		apiKey,
		authenticationType,
		payload,
		canonicalUri,
		appSyncGraphqlEndpoint,
		region,
		additionalCustomHeaders,
	}: AWSAppSyncRealTimeAuthInput): Promise<
		Record<string, unknown> | undefined
	> {
		const headerHandler: {
			[key in GraphQLAuthMode]: (arg0: AWSAppSyncRealTimeAuthInput) => {};
		} = {
			apiKey: this._awsRealTimeApiKeyHeader.bind(this),
			iam: this._awsRealTimeIAMHeader.bind(this),
			oidc: this._awsAuthTokenHeader.bind(this),
			userPool: this._awsAuthTokenHeader.bind(this),
			lambda: this._customAuthHeader,
			none: this._customAuthHeader,
		};

		if (!authenticationType || !headerHandler[authenticationType]) {
			logger.debug(`Authentication type ${authenticationType} not supported`);
			return undefined;
		} else {
			const handler = headerHandler[authenticationType];

			const host = appSyncGraphqlEndpoint
				? new AmplifyUrl(appSyncGraphqlEndpoint).host
				: undefined;

			logger.debug(`Authenticating with ${JSON.stringify(authenticationType)}`);
			let resolvedApiKey;
			if (authenticationType === 'apiKey') {
				resolvedApiKey = apiKey;
			}
			const result = await handler({
				payload,
				canonicalUri,
				appSyncGraphqlEndpoint,
				apiKey: resolvedApiKey,
				region,
				host,
				additionalCustomHeaders,
			});

			return result;
		}
	}

	private async _awsAuthTokenHeader({ host }: AWSAppSyncRealTimeAuthInput) {
		const session = await fetchAuthSession();

		return {
			Authorization: session?.tokens?.accessToken?.toString(),
			host,
		};
	}

	private async _awsRealTimeApiKeyHeader({
		apiKey,
		host,
	}: AWSAppSyncRealTimeAuthInput) {
		const dt = new Date();
		const dtStr = dt.toISOString().replace(/[:\-]|\.\d{3}/g, '');

		return {
			host,
			'x-amz-date': dtStr,
			'x-api-key': apiKey,
		};
	}

	private async _awsRealTimeIAMHeader({
		payload,
		canonicalUri,
		appSyncGraphqlEndpoint,
		region,
	}: AWSAppSyncRealTimeAuthInput) {
		const endpointInfo = {
			region,
			service: 'appsync',
		};

		const creds = (await fetchAuthSession()).credentials;

		const request = {
			url: `${appSyncGraphqlEndpoint}${canonicalUri}`,
			data: payload,
			method: 'POST',
			headers: { ...AWS_APPSYNC_REALTIME_HEADERS },
		};

		const signed_params = signRequest(
			{
				headers: request.headers,
				method: request.method,
				url: new AmplifyUrl(request.url),
				body: request.data,
			},
			{
				// TODO: What do we need to do to remove these !'s?
				credentials: creds!,
				signingRegion: endpointInfo.region!,
				signingService: endpointInfo.service,
			}
		);
		return signed_params.headers;
	}

	private _customAuthHeader({
		host,
		additionalCustomHeaders,
	}: AWSAppSyncRealTimeAuthInput) {
		/**
		 * If `additionalHeaders` was provided to the subscription as a function,
		 * the headers that are returned by that function will already have been
		 * provided before this function is called.
		 */
		if (!additionalCustomHeaders?.['Authorization']) {
			throw new Error('No auth token specified');
		}

		return {
			Authorization: additionalCustomHeaders.Authorization,
			host,
		};
	}
}
