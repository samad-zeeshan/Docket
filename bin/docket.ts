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

// Alarm target is passed in at deploy time, never committed. A real address in a
// public repo is an address that gets scraped, and a placeholder in cdk.json is
// worse: it silently subscribes nobody and looks like it worked.
//
//   npx cdk deploy Docket --context docket:alarmEmail=you@example.com
//
// With no address the topic and the alarms still exist, they just email nobody.
const alarmEmail = (app.node.tryGetContext('docket:alarmEmail') as string | undefined) || undefined;

// Must match the repository exactly, including case. The OIDC subject claim
// carries the real name, and the IAM StringLike condition is case sensitive, so
// a lowercase name here means the deploy role can never be assumed.
const cicd = new DocketCicdStack(app, 'DocketCicd', {
  env,
  githubOwner: 'samad-zeeshan',
  githubRepo: 'Docket',
});

const docket = new DocketStack(app, 'Docket', { env, alarmEmail });

// AWS best-practice checks run at synth, so a rule violation fails the build the
// same way a failing test does. Everything we accept on purpose is suppressed
// with a written reason in lib/nag-suppressions.ts, never silently.
applyNagSuppressions(docket, cicd);
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
