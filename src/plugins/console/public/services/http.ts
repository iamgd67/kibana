/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { HttpSetup } from '@kbn/core/public';

export class HttpService {
  private client: any;

  public setup(httpClient: HttpSetup): void {
    this.client = httpClient;
  }

  public get httpClient(): HttpSetup {
    return this.client;
  }
}

export const httpService = new HttpService();
