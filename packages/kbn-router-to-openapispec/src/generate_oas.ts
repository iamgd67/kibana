/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

/**
 * Heavily adapted version of https://github.com/jlalmes/trpc-openapi
 */

import type { OpenAPIV3 } from 'openapi-types';

import { CoreVersionedRouter, Router } from '@kbn/core-http-router-server-internal';
import { versionHandlerResolvers } from '@kbn/core-http-router-server-internal';
import { VersionedRouterRoute } from '@kbn/core-http-router-server-internal/src/versioned_router/types';
import {
  getPathParameters,
  extractValidationSchemaFromVersionedHandler,
  getVersionedContentString,
  extractValidationSchemaFromRoute,
  getJSONContentString,
} from './util';

import { convert, convertPathParameters, convertQuery } from './oas_converters';

export const openApiVersion = '3.0.0';

export interface GenerateOpenApiDocumentOptions {
  title: string;
  description?: string;
  version: string;
  baseUrl: string;
  docsUrl?: string;
  tags?: string[];
  pathStartsWith?: string;
}

export const generateOpenApiDocument = (
  appRouters: { routers: Router[]; versionedRouters: CoreVersionedRouter[] },
  opts: GenerateOpenApiDocumentOptions
): OpenAPIV3.Document => {
  const paths: OpenAPIV3.PathsObject = {};
  for (const router of appRouters.routers) {
    Object.assign(paths, processRouter(router, opts.pathStartsWith));
  }
  for (const router of appRouters.versionedRouters) {
    Object.assign(paths, processVersionedRouter(router, opts.pathStartsWith));
  }
  return {
    openapi: openApiVersion,
    info: {
      title: opts.title,
      description: opts.description,
      version: opts.version,
    },
    servers: [
      {
        url: opts.baseUrl,
      },
    ],
    paths,
    security: [
      {
        basicAuth: [],
      },
      {
        apiKeyAuth: [],
      },
    ],
    tags: opts.tags?.map((tag) => ({ name: tag })),
    externalDocs: opts.docsUrl ? { url: opts.docsUrl } : undefined,
  };
};

const operationIdCounters = new Map<string, number>();
const getOperationId = (name: string): string => {
  // Aliases an operationId to ensure it is unique across
  // multiple method+path combinations sharing a name.
  // "search" -> "search#0", "search#1", etc.
  const operationIdCount = operationIdCounters.get(name) ?? 0;
  const aliasedName = name + '#' + operationIdCount.toString();
  operationIdCounters.set(name, operationIdCount + 1);
  return aliasedName;
};

const extractRequestBody = (
  route: VersionedRouterRoute
): OpenAPIV3.RequestBodyObject['content'] => {
  return route.handlers.reduce<OpenAPIV3.RequestBodyObject['content']>((acc, handler) => {
    const schemas = extractValidationSchemaFromVersionedHandler(handler);
    if (!schemas?.request) return acc;
    const schema = convert(schemas.request.body);
    return {
      ...acc,
      [getVersionedContentString(handler.options.version)]: {
        schema,
      },
    };
  }, {} as OpenAPIV3.RequestBodyObject['content']);
};
const extractVersionedResponses = (route: VersionedRouterRoute): OpenAPIV3.ResponsesObject => {
  return route.handlers.reduce<OpenAPIV3.ResponsesObject>((acc, handler) => {
    const schemas = extractValidationSchemaFromVersionedHandler(handler);
    if (!schemas?.response) return acc;
    const statusCodes = Object.keys(schemas.response);
    for (const statusCode of statusCodes) {
      const maybeSchema = schemas.response[statusCode as unknown as number].body;
      const schema = convert(maybeSchema);
      acc[statusCode] = {
        ...acc[statusCode],
        description: route.options.description ?? 'No description',
        content: {
          ...((acc[statusCode] ?? {}) as OpenAPIV3.ResponseObject).content,
          [getVersionedContentString(handler.options.version)]: {
            schema,
          },
        },
      };
    }
    return acc;
  }, {});
};

const prepareRoutes = <R extends { path: string; options: { access?: 'public' | 'internal' } }>(
  routes: R[],
  pathStartsWith?: string
): R[] => {
  return (
    routes
      // TODO: Make this smarter?
      .filter(pathStartsWith ? (route) => route.path.startsWith(pathStartsWith) : () => true)
    // TODO: Figure out how we can scope which routes we generate OAS for
    // .filter((route) => route.options.access === 'public')
  );
};

const processVersionedRouter = (
  appRouter: CoreVersionedRouter,
  pathStartsWith?: string
): OpenAPIV3.PathsObject => {
  const routes = prepareRoutes(appRouter.getRoutes(), pathStartsWith);
  const paths: OpenAPIV3.PathsObject = {};
  for (const route of routes) {
    const pathParams = getPathParameters(route.path);
    /**
     * Note: for a given route we accept that route params and query params remain BWC
     *       so we only take the latest version of the params and query params, we also
     *       assume at this point that we are generating for serverless.
     */
    let pathObjects: OpenAPIV3.ParameterObject[] = [];
    let queryObjects: OpenAPIV3.ParameterObject[] = [];
    const version = versionHandlerResolvers.newest(
      route.handlers.map(({ options: { version: v } }) => v)
    );
    const handler = route.handlers.find(({ options: { version: v } }) => v === version);
    const schemas = handler ? extractValidationSchemaFromVersionedHandler(handler) : undefined;

    try {
      if (handler && schemas) {
        const params = schemas.request?.params as unknown;
        if (params) {
          pathObjects = convertPathParameters(params, pathParams);
        }
        const query = schemas.request?.query as unknown;
        if (query) {
          queryObjects = convertQuery(query);
        }
      }

      const hasBody = Boolean(
        handler && extractValidationSchemaFromVersionedHandler(handler)?.request?.body
      );
      const path: OpenAPIV3.PathItemObject = {
        [route.method]: {
          requestBody: hasBody
            ? {
                content: extractRequestBody(route),
              }
            : undefined,
          responses: extractVersionedResponses(route),
          parameters: pathObjects.concat(queryObjects),
          operationId: getOperationId(route.path),
        },
      };

      assignToPathsObject(paths, route.path, path);
    } catch (e) {
      // Enrich the error message with a bit more context
      e.message = `Error generating OpenAPI for route '${route.path}' using version '${version}': ${e.message}`;
      throw e;
    }
  }
  return paths;
};

type InternalRouterRoute = ReturnType<Router['getRoutes']>[0];

const extractResponses = (route: InternalRouterRoute): OpenAPIV3.ResponsesObject => {
  return !!route.options?.responses
    ? Object.entries(route.options.responses).reduce<OpenAPIV3.ResponsesObject>(
        (acc, [statusCode, schema]) => {
          const oasSchema = convert(schema.body);
          acc[statusCode] = {
            ...acc[statusCode],
            description: route.options.description ?? 'No description',
            content: {
              ...((acc[statusCode] ?? {}) as OpenAPIV3.ResponseObject).content,
              [getJSONContentString()]: {
                schema: oasSchema,
              },
            },
          };
          return acc;
        },
        {}
      )
    : {};
};

const processRouter = (appRouter: Router, pathStartsWith?: string): OpenAPIV3.PathsObject => {
  const routes = prepareRoutes(appRouter.getRoutes(true), pathStartsWith);

  const paths: OpenAPIV3.PathsObject = {};
  for (const route of routes) {
    const pathParams = getPathParameters(route.path);
    const validationSchemas = extractValidationSchemaFromRoute(route);

    let pathObjects: OpenAPIV3.ParameterObject[] = [];
    let queryObjects: OpenAPIV3.ParameterObject[] = [];

    try {
      if (validationSchemas) {
        const params = validationSchemas.params as unknown;
        if (params) {
          pathObjects = convertPathParameters(params, pathParams);
        }
        const query = validationSchemas.query as unknown;
        if (query) {
          queryObjects = convertQuery(query);
        }
      }

      const path: OpenAPIV3.PathItemObject = {
        [route.method]: {
          requestBody: !!validationSchemas?.body
            ? {
                content: {
                  [getJSONContentString()]: {
                    schema: convert(validationSchemas.body),
                  },
                },
              }
            : undefined,
          responses: extractResponses(route),
          parameters: pathObjects.concat(queryObjects),
          operationId: getOperationId(route.path),
        },
      };
      assignToPathsObject(paths, route.path, path);
    } catch (e) {
      // Enrich the error message with a bit more context
      e.message = `Error generating OpenAPI for route '${route.path}': ${e.message}`;
      throw e;
    }
  }
  return paths;
};

const assignToPathsObject = (
  paths: OpenAPIV3.PathsObject,
  path: string,
  pathObject: OpenAPIV3.PathItemObject
): void => {
  const pathName = path.replace('?', '');
  paths[pathName] = { ...paths[pathName], ...pathObject };
};
