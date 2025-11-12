/**
 * Shared Lambda Powertools instances. One logger, metrics buffer, and tracer per
 * container, configured from the service name the CDK sets per function.
 */
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';

const serviceName = process.env.POWERTOOLS_SERVICE_NAME ?? 'docket';

// Namespace is fixed so every function's metrics land under one CloudWatch
// namespace the dashboard can read.
export const logger = new Logger({ serviceName });
export const metrics = new Metrics({ namespace: 'Docket', serviceName });
export const tracer = new Tracer({ serviceName });
