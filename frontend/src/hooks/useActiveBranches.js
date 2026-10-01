import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export const DEFAULT_BRANCH_NAMES = [
  'Main - Brgy 7',
  '2nd Branch - Brgy Calzada',
  '3rd Branch - Nasugbu',
]

export default function useActiveBranches() {
  const [branchNames, setBranchNames] = useState(DEFAULT_BRANCH_NAMES)

  const loadBranches = useCallback(async () => {
    const { data, error } = await supabase
      .from('branches')
      .select('name')
      .eq('is_active', true)
      .order('name')

    if (error) {
      console.error('Unable to load active branches:', error)
      return
    }

    const names = (data || []).map(branch => branch.name?.trim()).filter(Boolean)
    setBranchNames(names.length ? names : DEFAULT_BRANCH_NAMES)
  }, [])

  useEffect(() => {
    loadBranches()
    const channel = supabase
      .channel('active-branch-options')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'branches' }, loadBranches)
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [loadBranches])

  return branchNames
}
