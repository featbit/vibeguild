#!/usr/bin/env node

// Beijing Weather Script
// Fetches current weather for Beijing using wttr.in API

import https from 'https';

function getBeijingWeather() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'wttr.in',
      path: '/Beijing?format=j1',
      method: 'GET',
      headers: {
        'User-Agent': 'curl/7.68.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const weatherData = JSON.parse(data);
          const current = weatherData.current_condition[0];

          const result = {
            location: 'Beijing, China',
            temperature: `${current.temp_C}°C (${current.temp_F}°F)`,
            feels_like: `${current.FeelsLikeC}°C (${current.FeelsLikeF}°F)`,
            description: current.weatherDesc[0].value,
            humidity: `${current.humidity}%`,
            wind: `${current.windspeedKmph} km/h ${current.winddir16Point}`,
            visibility: `${current.visibility} km`,
            uv_index: current.uvIndex,
            time: weatherData.current_condition[0].observation_time
          };

          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse weather data: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout after 10 seconds'));
    });

    req.end();
  });
}

// Format and display weather
async function main() {
  try {
    const weather = await getBeijingWeather();

    console.log('╔═══════════════════════════════════════╗');
    console.log('║       🌤️  BEIJING WEATHER REPORT       ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log('');
    console.log(`📍 Location:    ${weather.location}`);
    console.log(`🌡️  Temperature: ${weather.temperature}`);
    console.log(`🌡️  Feels Like:  ${weather.feels_like}`);
    console.log(`☁️  Condition:   ${weather.description}`);
    console.log(`💧 Humidity:    ${weather.humidity}`);
    console.log(`💨 Wind:        ${weather.wind}`);
    console.log(`👁️  Visibility:  ${weather.visibility}`);
    console.log(`☀️  UV Index:    ${weather.uv_index}`);
    console.log(`🕐 Observed:    ${weather.time}`);
    console.log('');
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the script
main();

export { getBeijingWeather };
