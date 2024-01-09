/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */
import type { DocView, DocViewFactory } from './types';

export enum ElasticRequestState {
  Loading,
  NotFound,
  Found,
  Error,
  NotFoundDataView,
}

export class DocViewsRegistry {
  private docViews: Map<string, DocView>;

  constructor(initialValue?: DocViewsRegistry | DocView[]) {
    if (initialValue instanceof DocViewsRegistry) {
      this.docViews = new Map(initialValue.docViews);
    } else if (Array.isArray(initialValue)) {
      this.docViews = new Map(initialValue.map((docView) => [docView.id, docView]));
    } else {
      this.docViews = new Map();
    }
  }

  getAll() {
    return [...this.docViews.values()];
  }

  add(docViewRaw: DocView | DocViewFactory) {
    const docView = typeof docViewRaw === 'function' ? docViewRaw() : docViewRaw;

    if (this.docViews.has(docView.id)) {
      throw new Error(
        `DocViewsRegistry#add: a DocView is already registered with id "${docView.id}".`
      );
    }

    this.docViews.set(docView.id, docView);
    // Sort the doc views at insertion time to perform this operation once and not on every retrieval.
    this.sortDocViews();
  }

  removeById(id: string) {
    this.docViews.delete(id);
  }

  clone() {
    return new DocViewsRegistry(this);
  }

  private sortDocViews() {
    const sortedEntries = [...this.docViews.entries()].sort(
      ([_currKey, curr], [_nextKey, next]) => curr.order - next.order
    );

    this.docViews = new Map(sortedEntries);
  }
}
