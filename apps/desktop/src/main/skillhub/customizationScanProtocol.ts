import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '@cindy/maker-core';

export interface CustomizationScanRequest {
  kind: 'scan';
  id: string;
  engine: AgentCustomization['engine'];
  options: ListCustomizationsOptions;
}

export interface CustomizationScanResponse {
  kind: 'result';
  id: string;
  result: ListCustomizationsResult;
}
