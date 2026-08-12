import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../server/ingest/classify.js';

test('identifies recalls', () => {
  const { category } = classify({
    title: 'Acme Ltd recalls one lot of Widget Injection',
    summary: 'Voluntary recall due to particulate matter.',
  });
  assert.equal(category, 'Recall');
});

test('identifies safety alerts and rates them high', () => {
  const { category, severity } = classify({
    title: 'Safety alert: risk of severe hepatic injury',
    summary: 'Prescribers should review therapy.',
  });
  assert.equal(category, 'Safety Alert');
  assert.equal(severity, 'high');
});

test('identifies approvals', () => {
  const { category } = classify({
    title: 'FDA approves new treatment for rare disease',
    summary: 'Marketing authorisation granted.',
  });
  assert.equal(category, 'Approval');
});

test('identifies guidance documents', () => {
  const { category } = classify({
    title: 'Draft guidance for industry: bioequivalence studies',
    summary: 'Consultation open until October.',
  });
  assert.equal(category, 'Guidance');
});

test('escalates language implying death or immediate cessation to critical', () => {
  assert.equal(
    classify({ title: 'Do not use Batch 42', summary: 'Reports of fatal outcomes.' }).severity,
    'critical',
  );
  assert.equal(
    classify({ title: 'Falsified medicine identified in supply chain', summary: '' }).severity,
    'critical',
  );
});

test("openFDA classification overrides the keyword guess", () => {
  const classI = classify({
    title: 'Routine sounding headline',
    summary: 'Nothing alarming in the wording.',
    openFdaClassification: 'Class I',
  });
  assert.equal(classI.severity, 'critical');
  assert.equal(classI.category, 'Recall');

  assert.equal(
    classify({ title: 'x', summary: '', openFdaClassification: 'Class III' }).severity,
    'medium',
  );
});

test('Class II is not mistaken for Class I', () => {
  const { severity } = classify({
    title: 'Class II recall of Product Q',
    summary: '',
    openFdaClassification: 'Class II',
  });
  assert.equal(severity, 'high');
});

test('falls back to Other/info for unremarkable text', () => {
  const { category, severity } = classify({
    title: 'Agency publishes annual report',
    summary: 'Overview of the year.',
  });
  assert.equal(category, 'Other');
  assert.equal(severity, 'info');
});
