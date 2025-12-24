/**
 * Read API: an HTTP API in front of a query Lambda, one document and one
 * list-by-status route. IAM auth so there is no long-lived key to store or leak,
 * and an unsigned request gets a 403.
 */
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { stackOutput } from '../stack-output';
import { HttpApi, HttpMethod, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture, Tracing } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
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

    // Access logs on the default stage. The L2 HttpApi does not expose these, so
    // set them on the underlying stage. One JSON line per request, which is what
    // makes "who called this and what did it return" answerable after the fact.
    const accessLogs = new LogGroup(this, 'ApiAccessLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const stage = this.httpApi.defaultStage?.node.defaultChild as CfnStage;
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        sourceIp: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLength: '$context.responseLength',
        integrationError: '$context.integrationErrorMessage',
      }),
    };

    stackOutput(this, 'ApiUrl', this.httpApi.apiEndpoint);
    stackOutput(this, 'Region', Stack.of(this).region);
  }
}
