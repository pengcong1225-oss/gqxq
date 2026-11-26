import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import ComplaintSourceSummary from '../src/components/ComplaintSourceSummary';
import type {ComplaintDetail} from '../src/types/api';

function renderSourceSummary(fields: Record<string, unknown>, sourceEventStatusCode = 'unknown') {
  const detail = {
    sourceId: 'FIXTURE-1', sourceEventStatusCode, sourceEventStatusName: '来源已关闭',
    supervisionStatusName: '企业已签收', sourceSummary: fields,
  } as ComplaintDetail;
  return new JSDOM(renderToStaticMarkup(
    <ComplaintSourceSummary detail={detail} canReadDocument={false} documentLoading={false} onReadDocument={() => {}} />,
  ));
}

function field(document: Document, label: string): string | null {
  const heading = Array.from(document.querySelectorAll('.ant-descriptions-item-label')).find(element => element.textContent === label);
  return heading?.nextElementSibling?.textContent ?? null;
}

test('a newer export displays its event status without populating the source supervision field', () => {
  const {window} = renderSourceSummary({eventStatus: '办理中', supervisionStatus: null}, 'closed');
  try {
    assert.equal(field(window.document, '来源事件状态'), '办理中');
    assert.equal(field(window.document, '来源督办状态'), '来源未提供');
    assert.equal(field(window.document, '来源同步状态'), '来源已关闭');
    assert.doesNotMatch(window.document.body.textContent ?? '', /企业已签收/);
  } finally { window.close(); }
});

test('an older export displays source supervision and its supplied completion times', () => {
  const {window} = renderSourceSummary({
    eventStatus: null, supervisionStatus: '超期结案',
    deadlineRaw: '2026-11-10 18:00:00', completedRaw: '2026-11-10 19:30:00',
  });
  try {
    assert.equal(field(window.document, '来源事件状态'), '来源未提供');
    assert.equal(field(window.document, '来源督办状态'), '超期结案');
    assert.equal(field(window.document, '规定完成时间（来源原件）'), '2026-11-10 18:00:00');
    assert.equal(field(window.document, '实际完成时间（来源原件）'), '2026-11-10 19:30:00');
    assert.doesNotMatch(window.document.body.textContent ?? '', /规定\/实际完成时间源表未提供/);
  } finally { window.close(); }
});
