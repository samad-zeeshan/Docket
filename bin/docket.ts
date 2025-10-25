#!/usr/bin/env node
/**
 * CDK app entry. Two stacks: a one-time CI/CD stack (GitHub OIDC + deploy role)
 * and the pipeline stack that CI deploys on every merge to main.
 */
import * as cdk from 'aws-cdk-lib';
import { DocketStack } from '../lib/docket-stack';
import { DocketCicdStack } from '../lib/cicd-stack';

const app = new cdk.App();

// Region is pinned. The directive forbids splitting regions and Bedrock model
// access is requested in us-east-1, so every stack lands there.
const env: cdk.Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

// Alarm target comes from cdk.json context so no email is hardcoded in source.
const alarmEmail = app.node.tryGetContext('docket:alarmEmail') as string | undefined;

new DocketCicdStack(app, 'DocketCicd', {
  env,
  githubOwner: 'samad-zeeshan',
  githubRepo: 'docket',
});

new DocketStack(app, 'Docket', { env, alarmEmail });
