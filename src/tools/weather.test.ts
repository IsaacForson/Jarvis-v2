import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWeather } from './weather.ts';

test('the weather report is cut down to what is worth saying', () => {
  const report = {
    nearest_area: [{ areaName: [{ value: 'Kumasi' }], country: [{ value: 'Ghana' }] }],
    current_condition: [{ temp_C: '24', FeelsLikeC: '28', weatherDesc: [{ value: 'Light rain shower ' }] }],
    weather: [{ maxtempC: '30', mintempC: '22', hourly: [{ chanceofrain: '20' }, { chanceofrain: '70' }] }],
  };
  assert.equal(describeWeather(report), 'Weather in Kumasi, Ghana: now Light rain shower, 24°C (feels like 28°C). Today 22 to 30°C, up to 70% chance of rain.');
  assert.throws(() => describeWeather({ ...report, weather: [] }), /empty report/);
});
