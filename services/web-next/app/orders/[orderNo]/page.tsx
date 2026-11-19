import { OrderPage } from '@/ui/pages/OrderPage.tsx'
import { ClientOnly } from '@/ui/shell.tsx'

export default function Page() {
  return <ClientOnly><OrderPage /></ClientOnly>
}
