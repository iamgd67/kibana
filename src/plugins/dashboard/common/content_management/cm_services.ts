/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */
import type {
  ContentManagementServicesDefinition as ServicesDefinition,
  Version,
} from '@kbn/object-versioning';

// We export the versioned service definition from this file and not the barrel to avoid adding
// the schemas in the "public" js bundle

import { serviceDefinitionV1 } from './v1';
import { serviceDefinitionV2 } from './v2';

export const cmServicesDefinition: { [version: Version]: ServicesDefinition } = {
  1: serviceDefinitionV1,
  2: serviceDefinitionV2,
};
