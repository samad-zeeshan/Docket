/**
 * The recorded v2 results the demo page shows: the four example receipts, the STP curve, calibration, routing and robustness.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');

function read(rel: string): unknown {
  const file = path.join(ROOT, rel);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// Trimmed to what the page draws. The full files stay in eval/results for anyone
// who wants every bin and every threshold.
export function v2Data() {
  const stp = read('eval/results/stp.json') as { curveCalibrated: unknown[]; curveVerbalized: unknown[]; operating: unknown[]; ladder: unknown[]; split: unknown } | null;
  const calibration = read('eval/results/calibration.json') as { fields: Record<string, unknown>[]; receipts: unknown; schemaFailures: number } | null;
  return {
    examples: read('demo/v2/examples.json'),
    stp: stp && { curveCalibrated: stp.curveCalibrated, curveVerbalized: stp.curveVerbalized, operating: stp.operating, ladder: stp.ladder, split: stp.split },
    calibration: calibration && {
      receipts: calibration.receipts,
      schemaFailures: calibration.schemaFailures,
      fields: calibration.fields.map((f) => ({
        field: f.field,
        n: f.n,
        testAccuracy: f.testAccuracy,
        verbalized: f.verbalized,
        calibrated: f.calibrated,
        reliabilityVerbalized: f.reliabilityVerbalized,
        reliabilityCalibrated: f.reliabilityCalibrated,
      })),
    },
    routing: read('eval/results/routing.json'),
    perturbation: read('eval/results/perturbation.json'),
    router: read('src/lib/params/router.json'),
  };
}
