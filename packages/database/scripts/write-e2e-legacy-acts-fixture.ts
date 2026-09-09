import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

const OUTPUT = process.argv[2] ?? join(tmpdir(), 'sgr-e2e-legacy-acts.xlsx');
const URL = 'https://bitrix.bir.by/doc/e2e-legacy-import';

const HEADERS = [
  '№ акта',
  'Форма акта',
  'Статус',
  'Объект',
  'Адрес объекта',
  'Номер / наименование помещения',
  'Вид дефекта',
  'Заказчик',
  'Виновная организация',
  'Ответственный инженер',
  'Дата составления',
  'Срок устранения',
  'Претензия',
  'Срок устранения по претензии',
  'Третья сторона (предложение А)',
  'Цена (предложение А)',
  'Третья сторона (предложение Б)',
  'Цена (предложение Б)',
  'Третья сторона (предложение В)',
  'Цена (предложение В)',
  'Срок устранения третьей ст.',
  'Ссылка на документ',
  'Примечания',
];

async function main(): Promise<void> {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Реестр актов');
  sheet.getCell(1, 1).value = 'Реестр';
  HEADERS.forEach((header, index) => {
    sheet.getCell(2, index + 1).value = header;
  });
  const row = [
    null,
    'С-23',
    null,
    'ЖК «Северный парк» (демо)',
    { formula: 'IFERROR(VLOOKUP(D4,#REF!,2,FALSE),"")' },
    'E2E-LEGACY-ROOM',
    'Замокание / течь',
    'ОАО «Северная инвестиционная группа» (демо)',
    'ООО «Тепломонтаж Альфа» (демо)',
    'Дмитрий Орлов',
    new Date(Date.UTC(2026, 2, 1)),
    'Не установлен',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    { text: URL, hyperlink: URL },
    null,
  ];
  row.forEach((value, index) => {
    sheet.getCell(4, index + 1).value = value as ExcelJS.CellValue;
  });
  const unmatched = [...row];
  unmatched[5] = 'E2E-UNMATCHED-ROOM';
  unmatched[9] = 'Лазарчик Е.В.';
  unmatched[21] = {
    text: 'https://bitrix.bir.by/doc/e2e-legacy-unmatched',
    hyperlink: 'https://bitrix.bir.by/doc/e2e-legacy-unmatched',
  };
  unmatched.forEach((value, index) => {
    sheet.getCell(5, index + 1).value = value as ExcelJS.CellValue;
  });
  await workbook.xlsx.writeFile(OUTPUT);
  process.stdout.write(`${OUTPUT}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
