/**
 * One-time CI/CD footprint: a GitHub OIDC provider and the role Actions assumes
 * to deploy. Separate stack because the role that deploys the app cannot be
 * created by the app stack it deploys.
 */
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface DocketCicdStackProps extends StackProps {
  githubOwner: string;
  githubRepo: string;
}

export class DocketCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: DocketCicdStackProps) {
    super(scope, id, props);

    // GitHub's OIDC identity provider, one per account. sts.amazonaws.com is the
    // audience the aws-actions/configure-aws-credentials action requests.
    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'docket-github-deploy',
      // Trust is scoped to this repo. Any branch may deploy, but nothing outside
      // the repo can assume the role, and there are no access keys to leak.
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.githubOwner}/${props.githubRepo}:*`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    // Modern bootstrap puts real permissions on the cdk-* roles. CI only needs to
    // assume those, so the deploy role stays free of raw service admin.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
