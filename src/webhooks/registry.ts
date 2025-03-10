import {createHmac} from 'crypto';
import http from 'http';

import {StatusCode} from '@shopify/network';

import {GraphqlClient} from '../clients/graphql/graphql_client';
import {ApiVersion, ShopifyHeader} from '../base_types';
import ShopifyUtilities from '../utils';
import {Context} from '../context';
import * as ShopifyErrors from '../error';

import {
  DeliveryMethod,
  RegisterOptions,
  RegisterReturn,
  WebhookCheckResponse,
  WebhookCheckResponseLegacy,
} from './types';

interface RegistryInterface {

  /**
   * Registers the Webhooks provided in the Context WEBHOOKS_REGISTRY
   *
   * @param options Parameters to register the Webhooks, including shop, accessToken
   */
  register(options: RegisterOptions): Promise<RegisterReturn>;

  /**
   * Processes the webhook request received from the Shopify API
   *
   * @param request HTTP request received from Shopify
   * @param response HTTP response to the request
   */
  process(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void>;

  /**
   * Confirms that the given path is a webhook path
   *
   * @param string path component of a URI
   */
  isWebhookPath(path: string): boolean;
}

function isSuccess(
  result: any,
  deliveryMethod: DeliveryMethod,
  webhookId?: string,
): boolean {
  let endpoint;
  switch (deliveryMethod) {
    case DeliveryMethod.Http:
      endpoint = 'webhookSubscription';
      break;
    case DeliveryMethod.EventBridge:
      endpoint = 'eventBridgeWebhookSubscription';
      break;
    case DeliveryMethod.PubSub:
      endpoint = 'pubSubWebhookSubscription';
      break;
    default:
      return false;
  }
  endpoint += webhookId ? 'Update' : 'Create';
  return Boolean(
    result.data &&
      result.data[endpoint] &&
      result.data[endpoint].webhookSubscription,
  );
}

// 2020-07 onwards
function versionSupportsEndpointField() {
  return ShopifyUtilities.versionCompatible(ApiVersion.July20);
}

function versionSupportsPubSub() {
  return ShopifyUtilities.versionCompatible(ApiVersion.July21);
}

function validateDeliveryMethod(deliveryMethod: DeliveryMethod) {
  if (
    deliveryMethod === DeliveryMethod.EventBridge &&
    !versionSupportsEndpointField()
  ) {
    throw new ShopifyErrors.UnsupportedClientType(
      `EventBridge webhooks are not supported in API version "${Context.API_VERSION}".`,
    );
  } else if (
    deliveryMethod === DeliveryMethod.PubSub &&
    !versionSupportsPubSub()
  ) {
    throw new ShopifyErrors.UnsupportedClientType(
      `Pub/Sub webhooks are not supported in API version "${Context.API_VERSION}".`,
    );
  }
}

function buildCheckQuery(topic: string): string {
  const query = `{
    webhookSubscriptions(first: 1, topics: ${topic}) {
      edges {
        node {
          id
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
            ... on WebhookEventBridgeEndpoint {
              arn
            }
            ${
              versionSupportsPubSub()
                ? '... on WebhookPubSubEndpoint { \
                    pubSubProject \
                    pubSubTopic \
                  }'
                : ''
            }
          }
        }
      }
    }
  }`;

  const legacyQuery = `{
    webhookSubscriptions(first: 1, topics: ${topic}) {
      edges {
        node {
          id
          callbackUrl
        }
      }
    }
  }`;

  return versionSupportsEndpointField() ? query : legacyQuery;
}

function buildQuery(
  topic: string,
  address: string,
  deliveryMethod: DeliveryMethod = DeliveryMethod.Http,
  webhookId?: string,
): string {
  validateDeliveryMethod(deliveryMethod);
  let identifier: string;
  if (webhookId) {
    identifier = `id: "${webhookId}"`;
  } else {
    identifier = `topic: ${topic}`;
  }

  let mutationName: string;
  let webhookSubscriptionArgs: string;
  let pubSubProject: string;
  let pubSubTopic: string;
  switch (deliveryMethod) {
    case DeliveryMethod.Http:
      mutationName = webhookId
        ? 'webhookSubscriptionUpdate'
        : 'webhookSubscriptionCreate';
      webhookSubscriptionArgs = `{callbackUrl: "${address}"}`;
      break;
    case DeliveryMethod.EventBridge:
      mutationName = webhookId
        ? 'eventBridgeWebhookSubscriptionUpdate'
        : 'eventBridgeWebhookSubscriptionCreate';
      webhookSubscriptionArgs = `{arn: "${address}"}`;
      break;
    case DeliveryMethod.PubSub:
      mutationName = webhookId
        ? 'pubSubWebhookSubscriptionUpdate'
        : 'pubSubWebhookSubscriptionCreate';
      [pubSubProject, pubSubTopic] = address
        .replace(/^pubsub:\/\//, '')
        .split(':');
      webhookSubscriptionArgs = `{pubSubProject: "${pubSubProject}",
                                  pubSubTopic: "${pubSubTopic}"}`;
      break;
  }

  return `
    mutation webhookSubscription {
      ${mutationName}(${identifier}, webhookSubscription: ${webhookSubscriptionArgs}) {
        userErrors {
          field
          message
        }
        webhookSubscription {
          id
        }
      }
    }
  `;
}

const MANDATORY_WEBHOOKS = ['CUSTOMERS_DATA_REQUEST', 'CUSTOMERS_REDACT', 'SHOP_REDACT'];

const WebhooksRegistry: RegistryInterface = {
  async register({
    accessToken,
    shop,
  }: RegisterOptions): Promise<RegisterReturn> {
    const client = new GraphqlClient(shop, accessToken);
    const topics = Object.keys(Context.WEBHOOKS_REGISTRY).filter((topic) => !MANDATORY_WEBHOOKS.includes(topic));
    const registerReturn: RegisterReturn = {};

    for (const topic of topics) {
      const {path, deliveryMethod = DeliveryMethod.Http} = Context.WEBHOOKS_REGISTRY[topic];
      const address = deliveryMethod === DeliveryMethod.Http
        ? `https://${Context.HOST_NAME}${path}`
        : path;
      const checkResult = (await client.query({
        data: buildCheckQuery(topic),
      })) as {body: WebhookCheckResponse | WebhookCheckResponseLegacy;};
      let webhookId: string | undefined;
      let mustRegister = true;
      if (checkResult.body.data.webhookSubscriptions.edges.length) {
        const {node} = checkResult.body.data.webhookSubscriptions.edges[0];
        let endpointAddress = '';
        if ('endpoint' in node) {
          if (node.endpoint.__typename === 'WebhookHttpEndpoint') {
            endpointAddress = node.endpoint.callbackUrl;
          } else if (node.endpoint.__typename === 'WebhookEventBridgeEndpoint') {
            endpointAddress = node.endpoint.arn;
          }
        } else {
          endpointAddress = node.callbackUrl;
        }
        webhookId = node.id;
        if (endpointAddress === address) {
          mustRegister = false;
        }
      }

      let success: boolean;
      let body: unknown;
      if (mustRegister) {
        const result = await client.query({
          data: buildQuery(topic, address, deliveryMethod, webhookId),
        });

        success = isSuccess(result.body, deliveryMethod, webhookId);
        body = result.body;
      } else {
        success = true;
        body = {};
      }

      registerReturn[topic] = {success, result: body};
    }

    return registerReturn;
  },

  async process(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    let reqBody = '';

    const promise: Promise<void> = new Promise((resolve, reject) => {
      request.on('data', (chunk) => {
        reqBody += chunk;
      });

      request.on('end', async () => {
        if (!reqBody.length) {
          response.writeHead(StatusCode.BadRequest);
          response.end();
          return reject(
            new ShopifyErrors.InvalidWebhookError(
              'No body was received when processing webhook',
            ),
          );
        }

        let hmac: string | string[] | undefined;
        let topic: string | string[] | undefined;
        let domain: string | string[] | undefined;
        Object.entries(request.headers).map(([header, value]) => {
          switch (header.toLowerCase()) {
            case ShopifyHeader.Hmac.toLowerCase():
              hmac = value;
              break;
            case ShopifyHeader.Topic.toLowerCase():
              topic = value;
              break;
            case ShopifyHeader.Domain.toLowerCase():
              domain = value;
              break;
          }
        });

        const missingHeaders = [];
        if (!hmac) {
          missingHeaders.push(ShopifyHeader.Hmac);
        }
        if (!topic) {
          missingHeaders.push(ShopifyHeader.Topic);
        }
        if (!domain) {
          missingHeaders.push(ShopifyHeader.Domain);
        }

        if (missingHeaders.length) {
          response.writeHead(StatusCode.BadRequest);
          response.end();
          return reject(
            new ShopifyErrors.InvalidWebhookError(
              `Missing one or more of the required HTTP headers to process webhooks: [${missingHeaders.join(
                ', ',
              )}]`,
            ),
          );
        }

        let statusCode: StatusCode | undefined;
        let responseError: Error | undefined;
        const headers = {};

        const generatedHash = createHmac('sha256', Context.API_SECRET_KEY)
          .update(reqBody, 'utf8')
          .digest('base64');

        if (ShopifyUtilities.safeCompare(generatedHash, hmac as string)) {
          const graphqlTopic = (topic as string).toUpperCase().replace(/\//g, '_');
          const webhookEntry = Context.WEBHOOKS_REGISTRY[graphqlTopic];

          if (webhookEntry) {
            try {
              await webhookEntry.webhookHandler(
                graphqlTopic,
                domain as string,
                reqBody,
              );
              statusCode = StatusCode.Ok;
            } catch (error) {
              statusCode = StatusCode.InternalServerError;
              responseError = error;
            }
          } else {
            statusCode = StatusCode.Forbidden;
            responseError = new ShopifyErrors.InvalidWebhookError(
              `No webhook is registered for topic ${topic}`,
            );
          }
        } else {
          statusCode = StatusCode.Forbidden;
          responseError = new ShopifyErrors.InvalidWebhookError(
            `Could not validate request for topic ${topic}`,
          );
        }

        response.writeHead(statusCode, headers);
        response.end();
        if (responseError) {
          return reject(responseError);
        } else {
          return resolve();
        }
      });
    });

    return promise;
  },

  isWebhookPath(path: string): boolean {
    for (const topic in Context.WEBHOOKS_REGISTRY) {
      if (Context.WEBHOOKS_REGISTRY[topic].path === path) {
        return true;
      }
    }
    return false;
  },
};

export {WebhooksRegistry, RegistryInterface, buildCheckQuery, buildQuery};