import { useEffect, useState } from 'react'
import { api } from '../api'

let cache: Promise<{ id: number; name: string }[]> | null = null
const loadBrands = () => (cache ??= api<{ brands: { id: number; name: string }[] }>('/brands').then((d) => d.brands))

/** Pick one brand (or none). */
export function BrandSelect({ id, value, onChange, disabled, emptyLabel }: {
  id?: string; value: number | null; onChange: (brandId: number | null) => void; disabled?: boolean; emptyLabel: string
}) {
  const [brands, setBrands] = useState<{ id: number; name: string }[]>([])
  useEffect(() => { loadBrands().then(setBrands) }, [])
  return (
    <select id={id} className="select" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{emptyLabel}</option>
      {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  )
}
