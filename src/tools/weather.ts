import type { Tool } from './types.ts';

type Report = {
  nearest_area: { areaName: { value: string }[]; country: { value: string }[] }[];
  current_condition: { temp_C: string; FeelsLikeC: string; weatherDesc: { value: string }[] }[];
  weather: { maxtempC: string; mintempC: string; hourly: { chanceofrain: string }[] }[];
};

export function describeWeather(report: Report): string {
  const area = report.nearest_area[0];
  const now = report.current_condition[0];
  const today = report.weather[0];
  if (!now || !today) throw new Error('The weather service sent an empty report.');
  const rain = Math.max(...today.hourly.map((hour) => Number(hour.chanceofrain) || 0));
  const place = area ? `${area.areaName[0]?.value}, ${area.country[0]?.value}` : 'here';
  return `Weather in ${place}: now ${now.weatherDesc[0]?.value.trim()}, ${now.temp_C}°C (feels like ${now.FeelsLikeC}°C). Today ${today.mintempC} to ${today.maxtempC}°C, up to ${rain}% chance of rain.`;
}

/** Today's weather where the Mac is, located by its internet address (wttr.in, no key needed). */
export const weatherTool: Tool = {
  name: 'weather',
  description: "Today's weather where the user is, or in a named place: conditions now, the day's low and high, and the chance of rain.",
  parameters: { type: 'object', properties: { place: { type: 'string', description: 'A city, if not where he is now' } } },
  slow: true,
  run: async (args) => {
    const place = typeof args.place === 'string' ? encodeURIComponent(args.place.trim()) : '';
    const response = await fetch(`https://wttr.in/${place}?format=j1`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`The weather service answered ${response.status}.`);
    return describeWeather((await response.json()) as Report);
  },
};
