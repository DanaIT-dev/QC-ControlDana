export const APPROVED_DEFECT_TYPES_SOURCE = 'APPROVED_DEFECT_TYPES_V1';

export const APPROVED_DEFECT_TYPES_V1 = [
  {
    sortOrder: 1,
    code: 'RETAINING_WALLS_PORCHES_PITS',
    name: 'Дефекты блоков подпорных стен / крылец / приямков',
  },
  { sortOrder: 2, code: 'WATER_SUPPLY', name: 'Дефекты водоснабжения' },
  { sortOrder: 3, code: 'SEWER', name: 'Дефекты канализации' },
  { sortOrder: 4, code: 'MASONRY', name: 'Дефекты кладки' },
  { sortOrder: 5, code: 'FLOORING', name: 'Дефекты напольного покрытия' },
  { sortOrder: 6, code: 'WINDOWS', name: 'Дефекты оконных изделий' },
  { sortOrder: 7, code: 'FINISHING', name: 'Дефекты отделки' },
  { sortOrder: 8, code: 'PORCH_FINISHING', name: 'Дефекты отделки крылец' },
  { sortOrder: 9, code: 'LOGGIA_FINISHING', name: 'Дефекты отделки лоджии' },
  { sortOrder: 10, code: 'SILLS', name: 'Дефекты отливов' },
  { sortOrder: 11, code: 'FLOOR_SLABS', name: 'Дефекты плит перекрытий' },
  { sortOrder: 12, code: 'RADIATORS', name: 'Дефекты радиаторов отопления' },
  { sortOrder: 13, code: 'SANITARY_WARE', name: 'Дефекты сантехнических изделий' },
  { sortOrder: 14, code: 'HEATING_SYSTEM', name: 'Дефекты системы отопления' },
  { sortOrder: 15, code: 'GLAZING', name: 'Дефекты стеклопакетов' },
  {
    sortOrder: 16,
    code: 'GLAZING_INSIDE',
    name: 'Дефекты стеклопакетов (замена изнутри)',
  },
  {
    sortOrder: 17,
    code: 'GLAZING_OUTSIDE',
    name: 'Дефекты стеклопакетов (замена снаружи)',
  },
  { sortOrder: 18, code: 'WALLS', name: 'Дефекты стен' },
  { sortOrder: 19, code: 'FACADE', name: 'Дефекты фасада' },
  { sortOrder: 20, code: 'ELECTRICAL', name: 'Дефекты электромонтажных работ' },
  { sortOrder: 21, code: 'LEAKAGE', name: 'Замокание / течь' },
  { sortOrder: 22, code: 'DRAFT_FREEZE', name: 'Продувы / промерзания' },
] as const;

export type ApprovedDefectTypeV1 = (typeof APPROVED_DEFECT_TYPES_V1)[number];
