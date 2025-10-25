/**
 * The Docket pipeline stack. Phase 0 is an empty shell so `cdk synth` has
 * something to render. Later phases add the ingest, extraction, API, and
 * observability constructs here.
 */
import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface DocketStackProps extends StackProps {
  alarmEmail?: string;
}

export class DocketStack extends Stack {
  constructor(scope: Construct, id: string, props: DocketStackProps = {}) {
    super(scope, id, props);

    Tags.of(this).add('project', 'docket');
  }
}
