/**
 * The Docket pipeline stack. Composes the ingest, extraction, API, and
 * observability constructs that later phases add.
 */
import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { IngestPipeline } from './constructs/pipeline';
import { QueryApi } from './constructs/api';
import { Observability } from './constructs/observability';

export interface DocketStackProps extends StackProps {
  alarmEmail?: string;
}

export class DocketStack extends Stack {
  readonly ingest: IngestPipeline;
  readonly api: QueryApi;

  constructor(scope: Construct, id: string, props: DocketStackProps = {}) {
    super(scope, id, props);

    Tags.of(this).add('project', 'docket');

    this.ingest = new IngestPipeline(this, 'Ingest');
    this.api = new QueryApi(this, 'Api', { table: this.ingest.table });
    new Observability(this, 'Observability', {
      ingest: this.ingest,
      api: this.api,
      alarmEmail: props.alarmEmail,
    });
  }
}
