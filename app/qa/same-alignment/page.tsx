import { headers } from 'next/headers'
import { notFound } from 'next/navigation'

import { isRed43LocalDevelopmentHostHeader } from './access'
import SameAlignmentQaClient from './client'

export default async function SameAlignmentQaPage() {
  const requestHeaders = await headers()
  if (!isRed43LocalDevelopmentHostHeader(requestHeaders.get('host'))) notFound()

  return <SameAlignmentQaClient />
}
