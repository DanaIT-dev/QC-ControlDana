export const OBJECT_DATE_COLUMN_PX = 124;
export const OBJECT_ACTIONS_COLUMN_PX = 148;
export const OBJECT_ENGINEER_MIN_PX = 168;
export const OBJECT_NAME_MIN_PX = 168;
export const OBJECT_ADDRESS_MIN_PX = 200;

export interface ObjectTableColumns {
  name: number;
  address: number;
  commissioned: number;
  warranty: number;
  engineers: number;
  actions: number;
  tableWidth: number;
  scrolls: boolean;
}

export function objectTableColumns(containerWidth: number, canEdit: boolean): ObjectTableColumns {
  const commissioned = OBJECT_DATE_COLUMN_PX;
  const warranty = OBJECT_DATE_COLUMN_PX;
  const actions = canEdit ? OBJECT_ACTIONS_COLUMN_PX : 0;
  const fixed = commissioned + warranty + actions;
  const width = Math.max(0, Math.floor(containerWidth));
  const minTable = OBJECT_NAME_MIN_PX + OBJECT_ADDRESS_MIN_PX + OBJECT_ENGINEER_MIN_PX + fixed;
  if (width < minTable) {
    return {
      name: OBJECT_NAME_MIN_PX,
      address: OBJECT_ADDRESS_MIN_PX,
      commissioned,
      warranty,
      engineers: OBJECT_ENGINEER_MIN_PX,
      actions,
      tableWidth: minTable,
      scrolls: true,
    };
  }
  const free = width - fixed;
  const engineers = Math.max(OBJECT_ENGINEER_MIN_PX, Math.round(free * 0.2));
  const flexible = free - engineers;
  const name = Math.round(flexible * 0.48);
  const address = flexible - name;
  return {
    name,
    address,
    commissioned,
    warranty,
    engineers,
    actions,
    tableWidth: width,
    scrolls: false,
  };
}
