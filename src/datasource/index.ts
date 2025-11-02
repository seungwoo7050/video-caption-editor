import { createApiDataSource } from './apiDataSource'
import { createMockDataSource } from './mockDataSource'

import type { DataSource, DataSourceKind } from './types'

function readDataSourceKind(): DataSourceKind {
  const raw = (import.meta.env.VITE_DATASOURCE ?? 'mock') as string
  return raw === 'api' ? 'api' : 'mock'
}

const kind = readDataSourceKind()

export const dataSource: DataSource =
  kind === 'api' ? createApiDataSource() : createMockDataSource()

export const dataSourceKind: DataSourceKind = kind
