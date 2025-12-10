#!/usr/bin/env node
/**
 * CDK app entry. Two stacks: a one-time CI/CD stack (GitHub OIDC + deploy role)
 * and the pipeline stack that CI deploys on every merge to main.
 */
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DocketStack } from '../lib/docket-stack';
import { DocketCicdStack } from '../lib/cicd-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';

const app = new cdk.App();

// Region is pinned. The directive forbids splitting regions and Bedrock model
// access is requested in us-east-1, so every stack lands there.
const env: cdk.Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

// Alarm target comes from cdk.json context so no email is hardcoded in source.
const alarmEmail = app.node.tryGetContext('docket:alarmEmail') as string | undefined;

const cicd = new DocketCicdStack(app, 'DocketCicd', {
  env,
  githubOwner: 'samad-zeeshan',
  githubRepo: 'docket',
});

const docket = new DocketStack(app, 'Docket', { env, alarmEmail });

// AWS best-practice checks run at synth, so a rule violation fails the build the
// same way a failing test does. Everything we accept on purpose is suppressed
// with a written reason in lib/nag-suppressions.ts, never silently.
applyNagSuppressions(docket, cicd);
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
