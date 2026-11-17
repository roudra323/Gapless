// k6 load test for the API through the Gateway (`make load`, docs/06 and docs/07).
// It drives the HPA demo: the API Pods' CPU goes above the 70% target, and the HPA adds Pods.
//
// BASE_URL is the Gateway (default: the kind node's NodePort, reached from the `kind` Docker network).
// The mix is close to real use: mostly the recent feed and the stats, some address pages.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://gapless-control-plane:30080';

export const options = {
  scenarios: {
    api: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 30 }, // ramp up
        { duration: __ENV.HOLD || '4m', target: 30 }, // hold: long enough for the HPA to react
        { duration: '20s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  // The run fails if the API fails or gets slow under load. 0.5 s is the ApiLatencyHigh threshold.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

// Runs once: collect a few addresses from the recent feed for the address requests.
export function setup() {
  const res = http.get(`${BASE_URL}/v1/transfers?limit=100`);
  if (res.status !== 200) {
    throw new Error(`setup: GET /v1/transfers returned ${res.status}; is the app deployed?`);
  }
  const addresses = [...new Set(res.json('data').flatMap((t) => [t.from, t.to]))];
  return { addresses };
}

export default function (data) {
  const roll = Math.random();
  let res;
  if (roll < 0.4) {
    res = http.get(`${BASE_URL}/v1/transfers?limit=25`, { tags: { name: '/v1/transfers' } });
  } else if (roll < 0.7) {
    res = http.get(`${BASE_URL}/v1/stats`, { tags: { name: '/v1/stats' } });
  } else {
    const list =
      data.addresses.length > 0 ? data.addresses : ['0x0000000000000000000000000000000000000001'];
    const address = list[Math.floor(Math.random() * list.length)];
    res = http.get(`${BASE_URL}/v1/addresses/${address}/transfers?limit=25`, {
      tags: { name: '/v1/addresses/:address/transfers' },
    });
  }
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(0.05);
}
