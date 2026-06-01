"use client";

import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
    applicationId: '80ca316a-8017-4556-be6d-bd49b967016c',
    clientToken: 'pubc1053c55140435697f0fdc7d12c105a1',
    site: 'datadoghq.com',
    service: 'griddog-frontend-nextjs14',
    env: 'dev',				// e.g. 'prod', 'staging-1', 'dev'
    version: '1.0.0',	// e.g. '1.0.0'
    sessionSampleRate: 100,			// capture 100% of sessions
    sessionReplaySampleRate: 100,	// capture 20% of sessions with replay
    trackResources: true,			// Enable Resource tracking
    trackUserInteractions: true,	// Enable Action tracking
    trackLongTasks: true,			// Enable Long Tasks tracking

    // ----- Recommended Options -----
    // allowedTracingUrls: '<BACKEND_URL>',		// Enable distributed tracing
    // defaultPrivacyLevel: 'mask-user-input',	// 'mask-user-input' | 'allow' | 'mask'
});

export default function DatadogInit() {
    return null;
  }