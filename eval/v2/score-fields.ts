/**
 * Per field right or wrong for a public receipt, on the fields its dataset labels and no others.
 */
import type { Receipt } from '../../src/lib/schema';
import { lineItemF1, moneyEqual, normText, optionalNumber } from '../score';
import type { LabelField } from '../public/map';

export function fieldCorrectness(
  pred: Receipt | undefined,
  label: Partial<Receipt>,
  fields: LabelField[],
): Partial<Record<LabelField, number>> {
  const out: Partial<Record<LabelField, number>> = {};
  for (const f of fields) {
    if (!pred) {
      out[f] = 0;
      continue;
    }
    switch (f) {
      case 'merchant':
        out[f] = normText(pred.merchant) === normText(label.merchant ?? '') ? 1 : 0;
        break;
      case 'date':
        out[f] = pred.date === label.date ? 1 : 0;
        break;
      case 'total':
        out[f] = label.total !== undefined && moneyEqual(pred.total, label.total) ? 1 : 0;
        break;
      case 'subtotal':
      case 'tax':
        out[f] = optionalNumber(pred[f], label[f]);
        break;
      // Binary, because calibration needs a yes or no: the lines are right only
      // when every line is.
      case 'lineItems':
        out[f] = lineItemF1(pred.lineItems, label.lineItems ?? []) === 1 ? 1 : 0;
        break;
    }
  }
  return out;
}
