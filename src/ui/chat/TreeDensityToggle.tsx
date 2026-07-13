import { useUiStore } from '../../store/zustand/uiStore'
import { ContractIcon, ExpandIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'

export function TreeDensityToggle({
  placement = 'floating',
}: {
  placement?: 'floating' | 'canvas'
}) {
  const expanded = useUiStore((state) => state.treeExpanded)
  const setExpanded = useUiStore((state) => state.setTreeExpanded)
  return (
    <Button
      type="button"
      data-ui="tree-density-toggle"
      data-placement={placement}
      data-state={expanded ? 'expanded' : 'contracted'}
      aria-label={expanded ? 'Contract tree nodes' : 'Expand tree nodes'}
      aria-pressed={expanded}
      title={expanded ? 'Contract tree nodes' : 'Expand tree nodes'}
      onClick={() => setExpanded(!expanded)}
    >
      {expanded ? <ContractIcon size={18} /> : <ExpandIcon size={18} />}
    </Button>
  )
}
