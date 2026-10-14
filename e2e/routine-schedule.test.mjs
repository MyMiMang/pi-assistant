import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSchedule, parseSchedule, scheduleCron, scheduleError, scheduleLabel } from '../apps/web/src/routine-schedule.ts';

test('daily, weekdays, weekly and aligned intervals round trip', () => {
 for (const cron of ['0 8 * * *', '35 19 * * 1-5', '15 9 * * 0', '*/5 * * * *', '*/30 * * * *', '0 */6 * * *']) assert.equal(scheduleCron(parseSchedule(cron)), cron);
 assert.equal(scheduleCron(parseSchedule('0 * * * *')), '0 */1 * * *');
 assert.equal(scheduleLabel('35 19 * * 1-5'), '工作日（周一至周五） 19:35');
});
test('special legacy expressions stay advanced and unchanged', () => {
 for (const cron of ['0 8 1 * *', '0 8 * * 1,3', '0 8 * * 7', '*/7 * * * *', '0 */5 * * *', '0 0 8 * * *', 'invalid']) {
  assert.equal(parseSchedule(cron).kind, 'advanced');
  assert.equal(scheduleCron(parseSchedule(cron)), null);
  assert.equal(scheduleLabel(cron), `高级计划：${cron}`);
 }
});
test('reject short, fractional, invalid and uneven intervals without generating a different schedule', () => {
 for (const every of ['', '0', '4', '7', '61', '5.5']) {
  const s = { ...defaultSchedule(), kind: 'interval', every };
  assert.ok(scheduleError(s)); assert.equal(scheduleCron(s), null);
 }
 for (const every of ['1', '2', '3', '4', '6', '8', '12', '24']) assert.equal(scheduleError({ ...defaultSchedule(), kind: 'interval', unit: 'hours', every }), null);
 assert.ok(scheduleError({ ...defaultSchedule(), time: '25:00' }));
});
