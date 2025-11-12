/**
 * Read API: an HTTP API in front of a query Lambda, one document and one
 * list-by-status route. IAM auth so there is no long-lived key to store or leak,
 * and an unsigned request gets a 403.
 */
import { Duration, CfnOutput, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'node:path';

export interface QueryApiProps {
  table: dynamodb.Table;
}

export class QueryApi extends Construct {
  readonly httpApi: HttpApi;
  readonly queryFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: QueryApiProps) {
    super(scope, id);

    this.queryFn = new NodejsFunction(this, 'QueryFn', {
      entry: path.join(__dirname, '..', '..', 'src', 'handlers', 'query.ts'),
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(15),
      memorySize: 256,
      tracing: Tracing.ACTIVE,
      environment: {
        TABLE_NAME: props.table.tableName,
        POWERTOOLS_SERVICE_NAME: 'query',
        LOG_LEVEL: 'INFO',
      },
      bundling: { minify: true, sourceMap: true, target: 'node20', externalModules: ['@aws-sdk/*'] },
    });

    // grantReadData covers Query on the status-index too, so no extra grant.
    props.table.grantReadData(this.queryFn);

    const integration = new HttpLambdaIntegration('QueryIntegration', this.queryFn);

    this.httpApi = new HttpApi(this, 'HttpApi', {
      defaultAuthorizer: new HttpIamAuthorizer(),
    });
    this.httpApi.addRoutes({ path: '/documents/{docId}', methods: [HttpMethod.GET], integration });
    this.httpApi.addRoutes({ path: '/documents', methods: [HttpMethod.GET], integration });

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'Region', { value: Stack.of(this).region });
  }
}
