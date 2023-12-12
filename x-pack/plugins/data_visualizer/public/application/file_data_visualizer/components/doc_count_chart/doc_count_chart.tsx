/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import { FileUploadPluginStart } from '@kbn/file-upload-plugin/public';
import dateMath from '@kbn/datemath';
import React, { FC, useEffect, useState, useCallback, useMemo } from 'react';
import { lastValueFrom } from 'rxjs';
import moment, { Moment } from 'moment';
import { useTimeBuckets } from '../../../common/hooks/use_time_buckets';
import { IMPORT_STATUS, Statuses } from '../import_progress';
import { EventRateChart, LineChartPoint } from './event_rate_chart';

const BAR_TARGET = 150;
const PROGRESS_INCREMENT = 5;
const FINISHED_CHECKS = 5;

export const DocCountChart: FC<{
  statuses: Statuses;
  dataStart: DataPublicPluginStart;
  index: string;
  mappingsString: string;
  fileUpload: FileUploadPluginStart;
  readDocCount: number;
}> = ({ statuses, dataStart, index, mappingsString, fileUpload, readDocCount }) => {
  // console.log('statuses', statuses);
  // console.log('dataStart', dataStart);
  // const [timeFieldName, setTimeFieldName] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [finished, setFinished] = useState(false);
  const [previousProgress, setPreviousProgress] = useState(0);
  // const [previousDocCount, setPreviousDocCount] = useState(0);
  const [eventRateChartData, setEventRateChartData] = useState<LineChartPoint[]>([]);
  const timeBuckets = useTimeBuckets();
  const [previousPredictedEnd, setPreviousPredictedEnd] = useState<Moment>(moment(0));

  // const [finishedChecksCountDown, setFinishedChecksCountDown] = useState(FINISHED_CHECKS);

  const timeFieldName: string | undefined = useMemo(() => {
    // console.log('mappingsString', mappingsString);

    const mappings = JSON.parse(mappingsString);
    const fields = Object.entries<{ type: string }>(mappings.properties);
    const dateFields = fields.filter(
      ([name, field]) => field.type === 'date' || field.type === 'date_nanos'
    );
    if (dateFields.length === 0) {
      return;
    }

    const timeField = dateFields.find(([name, field]) => name === '@timestamp') ?? dateFields[0];
    return timeField[0];
  }, [mappingsString]);

  const loadData = useCallback(
    async (progress: number) => {
      if (timeFieldName === undefined) {
        return;
      }

      setLoading(true);
      timeBuckets.setInterval('auto');

      const { start, end } = await fileUpload.getTimeFieldRange(
        index,
        {
          bool: {
            must: [
              {
                match_all: {},
              },
            ],
          },
        },
        timeFieldName
      );

      const timeDiff = end.epoch - start.epoch;
      let predictedEnd = moment(start.epoch + Math.round(timeDiff / (progress / 100)));

      if (progress === 100) {
        predictedEnd = moment(end.epoch);
        setPreviousPredictedEnd(predictedEnd);
      } else {
        const predictedEndMs = predictedEnd.valueOf();
        const previousPredictedEndMs = previousPredictedEnd.valueOf();
        if (predictedEndMs > previousPredictedEndMs) {
          // console.log('setting new previousPredictedEnd', predictedEnd);
          setPreviousPredictedEnd(predictedEnd);
        } else {
          predictedEnd = previousPredictedEnd;
        }
      }

      const predictedEndMs = predictedEnd.valueOf();

      // console.log('newEndMs', predictedEndMs);
      // if (progress === 100) {
      //   console.log('real end', end);
      // }

      // console.log(end.epoch, newEndMs);

      if (start != null && end != null) {
        timeBuckets.setBounds({
          min: dateMath.parse(start.string),
          max: predictedEnd,
        });
        timeBuckets.setBarTarget(BAR_TARGET);
      }
      const intervalMs = timeBuckets.getInterval().asMilliseconds();
      // console.log('intervalMs', intervalMs);

      // console.log('loadData');

      const resp = await lastValueFrom(
        dataStart.search.search({
          params: {
            index,
            body: {
              size: 0,
              query: {
                bool: {
                  must: [
                    {
                      range: {
                        '@timestamp': {
                          gte: start.epoch,
                          lte: predictedEndMs,
                          format: 'epoch_millis',
                        },
                      },
                    },
                    {
                      match_all: {},
                    },
                  ],
                },
              },
              aggs: {
                eventRate: {
                  date_histogram: {
                    field: timeFieldName,
                    fixed_interval: `${intervalMs}ms`,
                    min_doc_count: 0,
                    ...(start.epoch !== undefined && predictedEndMs !== undefined
                      ? {
                          extended_bounds: {
                            min: start.epoch,
                            max: predictedEndMs,
                          },
                        }
                      : {}),
                  },
                },
              },
            },
          },
        })
      );
      setLoading(false);
      // @ts-expect-error
      if (resp?.rawResponse?.aggregations?.eventRate?.buckets !== undefined) {
        // @ts-expect-error
        const dd: LineChartPoint[] = resp.rawResponse.aggregations.eventRate.buckets.map((b) => ({
          time: b.key,
          value: b.doc_count,
        }));

        setEventRateChartData(dd);
      }

      // console.log('resp', resp);
    },
    [dataStart.search, fileUpload, index, previousPredictedEnd, timeBuckets, timeFieldName]
  );

  const finishedChecks = useCallback(
    async (counter: number) => {
      loadData(100);
      if (counter !== 0) {
        setTimeout(() => {
          finishedChecks(counter - 1);
        }, 2 * 1000);
      }
    },
    [loadData]
  );

  useEffect(() => {
    // console.log(statuses);

    if (loading === false && statuses.uploadProgress > 1 && statuses.uploadProgress < 100) {
      if (statuses.uploadProgress - previousProgress > PROGRESS_INCREMENT) {
        setPreviousProgress(statuses.uploadProgress);

        // console.log('loadData', statuses.uploadProgress);
        loadData(statuses.uploadProgress);
      }
    } else if (loading === false && statuses.uploadProgress === 100 && finished === false) {
      setFinished(true);
      finishedChecks(FINISHED_CHECKS);
    }
  }, [finished, finishedChecks, loadData, loading, previousProgress, readDocCount, statuses]);

  if (
    timeFieldName === undefined ||
    statuses.indexCreatedStatus === IMPORT_STATUS.INCOMPLETE ||
    statuses.ingestPipelineCreatedStatus === IMPORT_STATUS.INCOMPLETE
  ) {
    return null;
  }

  return (
    <>
      <EventRateChart
        eventRateChartData={eventRateChartData}
        height={'150px'}
        width={'100%'}
        showAxis={true}
      />
    </>
  );
};
