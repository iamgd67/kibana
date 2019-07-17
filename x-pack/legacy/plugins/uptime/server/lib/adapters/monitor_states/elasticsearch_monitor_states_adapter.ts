/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { get, set, sortBy } from 'lodash';
import { DatabaseAdapter } from '../database';
import { UMMonitorStatesAdapter } from './adapter_types';
import {
  MonitorSummary,
  SummaryHistogram,
  Check,
  StatesIndexStatus,
} from '../../../../common/graphql/types';
import { INDEX_NAMES, LEGACY_STATES_QUERY_SIZE } from '../../../../common/constants';
import { getHistogramInterval, getFilteredQueryAndStatusFilter } from '../../helper';

type SortChecks = (check: Check) => string[];
const checksSortBy = (check: Check) => [
  get<string>(check, 'observer.geo.name'),
  get<string>(check, 'monitor.ip'),
];

interface LegacyMonitorStatesQueryResult {
  result: any;
  statusFilter?: any;
  afterKey: any | null;
}

interface LegacyMonitorStatesRecentCheckGroupsQueryResult {
  checkGroups: string[];
  afterKey: any | null;
}

export class ElasticsearchMonitorStatesAdapter implements UMMonitorStatesAdapter {
  constructor(private readonly database: DatabaseAdapter) {
    this.database = database;
  }

  // This query returns the most recent check groups for a given
  // monitor ID.
  private async runLegacyMonitorStatesRecentCheckGroupsQuery(
    request: any,
    query: any,
    searchAfter?: any
  ): Promise<LegacyMonitorStatesRecentCheckGroupsQueryResult> {
    const body = {
      query: {
        bool: {
          filter: [
            {
              // We check for summary.up to ensure that the check group
              // is complete. Summary fields are only present on
              // completed check groups.
              exists: {
                field: 'summary.up',
              },
            },
            query,
          ],
        },
      },
      sort: [
        {
          '@timestamp': 'desc',
        },
      ],
      size: 0,
      aggs: {
        monitors: {
          composite: {
            size: LEGACY_STATES_QUERY_SIZE,
            sources: [
              {
                monitor_id: {
                  terms: {
                    field: 'monitor.id',
                  },
                },
              },
            ],
          },
          aggs: {
            top: {
              top_hits: {
                sort: [
                  {
                    '@timestamp': 'desc',
                  },
                ],
                _source: {
                  includes: ['monitor.check_group', '@timestamp', 'agent.id'],
                },
                // The idea here is that we want to get enough documents to get all
                // possible agent IDs. Doing that in a deterministic way is hard,
                // but all agent IDs should be represented in the top 50 results in most cases.
                // There's an edge case here where a user has accidentally configured
                // two agents to run on different schedules, but that's an issue on the user side.
                size: 50,
              },
            },
          },
        },
      },
    };

    if (searchAfter) {
      set(body, 'aggs.monitors.composite.after', searchAfter);
    }

    const params = {
      index: INDEX_NAMES.HEARTBEAT,
      body,
    };

    const result = await this.database.search(request, params);

    const checkGroups = result.aggregations.monitors.buckets.flatMap((bucket: any) => {
      const topHits = get<any[]>(bucket, 'top.hits.hits', []);

      const latestAgentGroup: { [key: string]: { timestamp: string; checkGroup: string } } = {};
      topHits.forEach(({ _source: source }) => {
        // We set the agent group to the first thing we see since it's already sorted
        // by timestamp descending
        if (!latestAgentGroup[source.agent.id]) {
          latestAgentGroup[source.agent.id] = {
            timestamp: source['@timestamp'],
            checkGroup: source.monitor.check_group,
          };
        }
      });

      return Object.values(latestAgentGroup).map(({ checkGroup }) => checkGroup);
    });

    const afterKey = get<any | null>(result, 'aggregations.monitors.after_key', null);
    return {
      checkGroups,
      afterKey,
    };
  }

  private async runLegacyMonitorStatesQuery(
    request: any,
    dateRangeStart: string,
    dateRangeEnd: string,
    filters?: string | null,
    searchAfter?: any
  ): Promise<LegacyMonitorStatesQueryResult> {
    const { query, statusFilter } = getFilteredQueryAndStatusFilter(
      dateRangeStart,
      dateRangeEnd,
      filters
    );

    // First we fetch the most recent check groups for this query
    // This is a critical performance optimization.
    // Without this the expensive scripted_metric agg below will run
    // over large numbers of documents.
    // It only really needs to run over the latest complete check group for each
    // agent.
    const { checkGroups, afterKey } = await this.runLegacyMonitorStatesRecentCheckGroupsQuery(
      request,
      query,
      searchAfter
    );

    const params = {
      index: INDEX_NAMES.HEARTBEAT,
      body: {
        query: {
          bool: {
            filter: [
              { terms: { 'monitor.check_group': checkGroups } },
              // Even though this work is already done when calculating the groups
              // this helps the planner
              query,
            ],
          },
        },
        sort: [{ '@timestamp': 'desc' }],
        size: 0,
        aggs: {
          monitors: {
            composite: {
              size: LEGACY_STATES_QUERY_SIZE,
              sources: [
                {
                  monitor_id: {
                    terms: {
                      field: 'monitor.id',
                    },
                  },
                },
              ],
            },
            aggregations: {
              state: {
                scripted_metric: {
                  init_script: `
                    // Globals are values that should be identical across all docs
                    // We can cheat a bit by always overwriting these and make the
                    // assumption that there is no variation in these across checks
                    state.globals = new HashMap();
                    // Here we store stuff broken out by agent.id and monitor.id
                    // This should correspond to a unique check.
                    state.checksByAgentIdIP = new HashMap();
                `,
                  map_script: `
                    Map curCheck = new HashMap();
                    String agentId = doc["agent.id"][0];
                    String ip = null;
                    if (doc["monitor.ip"].length > 0) {
                      ip = doc["monitor.ip"][0];
                    }
                    String agentIdIP = agentId + "-" + (ip == null ? "" : ip.toString());
                    def ts = doc["@timestamp"][0].toInstant().toEpochMilli();
                    
                    def lastCheck = state.checksByAgentIdIP[agentId];
                    Instant lastTs = lastCheck != null ? lastCheck["@timestamp"] : null;
                    if (lastTs != null && lastTs > ts) {
                      return;
                    }
                    
                    curCheck.put("@timestamp", ts);
                    
                    Map agent = new HashMap();
                    agent.id = agentId;
                    curCheck.put("agent", agent);
                    
                    if (state.globals.url == null) {
                      Map url = new HashMap();
                      Collection fields = ["full", "original", "scheme", "username", "password", "domain", "port", "path", "query", "fragment"];
                      for (field in fields) {
                        String docPath = "url." + field;
                        def val = doc[docPath];
                        if (!val.isEmpty()) {
                          url[field] = val[0];
                        }
                      }
                      state.globals.url = url;
                    }
                    
                    Map monitor = new HashMap();
                    monitor.status = doc["monitor.status"][0];
                    monitor.ip = ip;
                    if (!doc["monitor.name"].isEmpty()) {
                      String monitorName = doc["monitor.name"][0];
                      if (monitor.name != "") {
                        monitor.name = monitorName;
                      }
                    }
                    curCheck.monitor = monitor;
                    
                    if (curCheck.observer == null) {
                      curCheck.observer = new HashMap();
                    }
                    if (curCheck.observer.geo == null) {
                      curCheck.observer.geo = new HashMap();
                    }
                    if (!doc["observer.geo.name"].isEmpty()) {
                      curCheck.observer.geo.name = doc["observer.geo.name"][0];
                    }
                    if (!doc["observer.geo.location"].isEmpty()) {
                      curCheck.observer.geo.location = doc["observer.geo.location"][0];
                    }
                    if (!doc["kubernetes.pod.uid"].isEmpty() && curCheck.kubernetes == null) {
                      curCheck.kubernetes = new HashMap();
                      curCheck.kubernetes.pod = new HashMap();
                      curCheck.kubernetes.pod.uid = doc["kubernetes.pod.uid"][0];
                    }
                    if (!doc["container.id"].isEmpty() && curCheck.container == null) {
                      curCheck.container = new HashMap();
                      curCheck.container.id = doc["container.id"][0];
                    }
                    
                    state.checksByAgentIdIP[agentIdIP] = curCheck;
                `,
                  combine_script: 'return state;',
                  reduce_script: `
                  // The final document
                  Map result = new HashMap();
                  
                  Map checks = new HashMap();
                  Instant maxTs = Instant.ofEpochMilli(0);
                  Collection ips = new HashSet();
                  Collection geoNames = new HashSet();
                  Collection podUids = new HashSet();
                  Collection containerIds = new HashSet();
                  String name = null; 
                  for (state in states) {
                    result.putAll(state.globals);
                    for (entry in state.checksByAgentIdIP.entrySet()) {
                      def agentIdIP = entry.getKey();
                      def check = entry.getValue();
                      def lastBestCheck = checks.get(agentIdIP);
                      def checkTs = Instant.ofEpochMilli(check.get("@timestamp"));
                  
                      if (maxTs.isBefore(checkTs)) { maxTs = checkTs}
                  
                      if (lastBestCheck == null || lastBestCheck.get("@timestamp") < checkTs) {
                        check["@timestamp"] = check["@timestamp"];
                        checks[agentIdIP] = check
                      }

                      if (check.monitor.name != null && check.monitor.name != "") {
                        name = check.monitor.name;
                      }

                      ips.add(check.monitor.ip);
                      if (check.observer != null && check.observer.geo != null && check.observer.geo.name != null) {
                        geoNames.add(check.observer.geo.name);
                      }
                      if (check.kubernetes != null && check.kubernetes.pod != null) {
                        podUids.add(check.kubernetes.pod.uid);
                      }
                      if (check.container != null) {
                        containerIds.add(check.container.id);
                      }
                    }
                  }
                  
                  // We just use the values so we can store these as nested docs
                  result.checks = checks.values();
                  result.put("@timestamp", maxTs);
                  
                  
                  Map summary = new HashMap();
                  summary.up = checks.entrySet().stream().filter(c -> c.getValue().monitor.status == "up").count();
                  summary.down = checks.size() - summary.up;
                  result.summary = summary;
                  
                  Map monitor = new HashMap();
                  monitor.ip = ips;
                  monitor.name = name;
                  monitor.status = summary.down > 0 ? (summary.up > 0 ? "mixed": "down") : "up";
                  result.monitor = monitor;
                  
                  Map observer = new HashMap();
                  Map geo = new HashMap();
                  observer.geo = geo;
                  geo.name = geoNames;
                  result.observer = observer;
                  
                  if (!podUids.isEmpty()) {
                    result.kubernetes = new HashMap();
                    result.kubernetes.pod = new HashMap();
                    result.kubernetes.pod.uid = podUids;
                  }

                  if (!containerIds.isEmpty()) {
                    result.container = new HashMap();
                    result.container.id = containerIds;
                  }

                  return result;
                `,
                },
              },
            },
          },
        },
      },
    };

    const result = await this.database.search(request, params);
    return { afterKey, result, statusFilter };
  }

  private getMonitorBuckets(queryResult: any, statusFilter?: any) {
    let monitors = get(queryResult, 'aggregations.monitors.buckets', []);
    if (statusFilter) {
      monitors = monitors.filter(
        (monitor: any) => get(monitor, 'state.value.monitor.status') === statusFilter
      );
    }
    return monitors;
  }

  public async legacyGetMonitorStates(
    request: any,
    dateRangeStart: string,
    dateRangeEnd: string,
    filters?: string | null
  ): Promise<MonitorSummary[]> {
    const monitors: any[] = [];
    let searchAfter: any | null = null;
    do {
      const { result, statusFilter, afterKey } = await this.runLegacyMonitorStatesQuery(
        request,
        dateRangeStart,
        dateRangeEnd,
        filters,
        searchAfter
      );
      monitors.push(...this.getMonitorBuckets(result, statusFilter));
      searchAfter = afterKey;
    } while (searchAfter !== null && monitors.length < LEGACY_STATES_QUERY_SIZE);

    const monitorIds: string[] = [];
    const summaries: MonitorSummary[] = monitors.map((monitor: any) => {
      const monitorId = get<string>(monitor, 'key.monitor_id');
      monitorIds.push(monitorId);
      let state = get<any>(monitor, 'state.value');
      state = {
        ...state,
        timestamp: state['@timestamp'],
      };
      const { checks } = state;
      if (checks) {
        state.checks = sortBy<SortChecks, Check>(checks, checksSortBy);
        state.checks = state.checks.map((check: any) => ({
          ...check,
          timestamp: check['@timestamp'],
        }));
      } else {
        state.checks = [];
      }
      return {
        monitor_id: monitorId,
        state,
      };
    });
    const histogramMap = await this.getHistogramForMonitors(
      request,
      dateRangeStart,
      dateRangeEnd,
      monitorIds
    );
    return summaries.map(summary => ({
      ...summary,
      histogram: histogramMap[summary.monitor_id],
    }));
  }

  public async getMonitorStates(
    request: any,
    pageIndex: number,
    pageSize: number,
    sortField?: string | null,
    sortDirection?: string | null
  ): Promise<MonitorSummary[]> {
    const params = {
      index: INDEX_NAMES.HEARTBEAT_STATES,
      body: {
        from: pageIndex * pageSize,
        size: pageSize,
      },
    };

    if (sortField) {
      set(params, 'body.sort', [
        {
          [sortField]: {
            order: sortDirection || 'asc',
          },
        },
      ]);
    }

    const result = await this.database.search(request, params);
    const hits = get(result, 'hits.hits', []);
    const monitorIds: string[] = [];
    const monitorStates = hits.map(({ _source }: any) => {
      const { monitor_id } = _source;
      monitorIds.push(monitor_id);
      const sourceState = get<any>(_source, 'state');
      const state = {
        ...sourceState,
        timestamp: sourceState['@timestamp'],
      };
      if (state.checks) {
        state.checks = sortBy<SortChecks, Check>(state.checks, checksSortBy).map(
          (check: any): Check => ({
            ...check,
            timestamp: check['@timestamp'],
          })
        );
      } else {
        state.checks = [];
      }
      return {
        monitor_id,
        state,
      };
    });

    const histogramMap = await this.getHistogramForMonitors(request, 'now-15m', 'now', monitorIds);
    return monitorStates.map(monitorState => ({
      ...monitorState,
      histogram: histogramMap[monitorState.monitor_id],
    }));
  }

  private async getHistogramForMonitors(
    request: any,
    dateRangeStart: string,
    dateRangeEnd: string,
    monitorIds: string[]
  ): Promise<{ [key: string]: SummaryHistogram }> {
    const params = {
      index: INDEX_NAMES.HEARTBEAT,
      body: {
        size: 0,
        query: {
          bool: {
            filter: [
              {
                terms: {
                  'monitor.id': monitorIds,
                },
              },
              {
                range: {
                  '@timestamp': {
                    gte: dateRangeStart,
                    lte: dateRangeEnd,
                  },
                },
              },
            ],
          },
        },
        aggs: {
          by_id: {
            terms: {
              field: 'monitor.id',
              size: LEGACY_STATES_QUERY_SIZE,
            },
            aggs: {
              histogram: {
                date_histogram: {
                  field: '@timestamp',
                  fixed_interval: getHistogramInterval(dateRangeStart, dateRangeEnd),
                  missing: 0,
                },
                aggs: {
                  status: {
                    terms: {
                      field: 'monitor.status',
                      size: 2,
                      shard_size: 2,
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = await this.database.search(request, params);

    const buckets: any[] = get(result, 'aggregations.by_id.buckets', []);
    return buckets.reduce((map: { [key: string]: any }, item: any) => {
      const points = get(item, 'histogram.buckets', []).map((histogram: any) => {
        const status = get(histogram, 'status.buckets', []).reduce(
          (statuses: { up: number; down: number }, bucket: any) => {
            if (bucket.key === 'up') {
              statuses.up = bucket.doc_count;
            } else if (bucket.key === 'down') {
              statuses.down = bucket.doc_count;
            }
            return statuses;
          },
          { up: 0, down: 0 }
        );
        return {
          timestamp: histogram.key,
          ...status,
        };
      });

      map[item.key] = {
        count: item.doc_count,
        points,
      };
      return map;
    }, {});
  }

  public async statesIndexExists(request: any): Promise<StatesIndexStatus> {
    // TODO: adapt this to the states index in future release
    const {
      _shards: { total },
      count,
    } = await this.database.count(request, { index: INDEX_NAMES.HEARTBEAT });
    return {
      indexExists: total > 0,
      docCount: {
        count,
      },
    };
  }
}
