const fs = require("fs");
const path = require("path");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  VerticalAlign,
  Header,
} = require("docx");

const LOGO_PATH = path.join(__dirname, "assets", "logo.jpeg");

// Размеры в docx задаются в half-points: 12pt -> 24, 14pt -> 28, 16pt -> 32, 18pt -> 36
const SZ = { body: 24, h2: 28, h3: 32, h4: 36, title: 144 };
// h2 = 14pt (бөлім тақырыптары: КІРІСПЕ, НЕГІЗГІ БӨЛІМ, ҚОРЫТЫНДЫ, ішкі тақырыпшалар)
const FONT = "Times New Roman";

function run(text, opts = {}) {
  return new TextRun({
    text,
    font: FONT,
    bold: opts.bold ?? false,
    italics: opts.italics ?? false,
    size: opts.size ?? SZ.body,
  });
}

function para(children, opts = {}) {
  return new Paragraph({
    alignment: opts.alignment ?? AlignmentType.JUSTIFIED,
    pageBreakBefore: opts.pageBreakBefore ?? false,
    keepNext: opts.keepNext ?? false,
    spacing: { before: 0, after: 0, ...(opts.spacing || {}) },
    children: Array.isArray(children) ? children : [children],
  });
}

function headerTable(group) {
  const today = new Date();
  const dateStr = `__.__.${today.getFullYear()}`;
  const noBorder = {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  };
  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  };

  const logoBuffer = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

  return new Table({
    width: { size: 9639, type: WidthType.DXA },
    columnWidths: [4820, 2500, 2319],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 4820, type: WidthType.DXA },
            borders: cellBorder,
            verticalAlign: VerticalAlign.CENTER,
            children: [
              para(run("Студенттің өзіндік жұмысы", { bold: false, size: 20 }), {
                alignment: AlignmentType.LEFT,
              }),
            ],
          }),
          new TableCell({
            width: { size: 2500, type: WidthType.DXA },
            borders: cellBorder,
            verticalAlign: VerticalAlign.CENTER,
            children: [
              para(run(group, { bold: false, size: 20 }), {
                alignment: AlignmentType.CENTER,
              }),
              para(run(dateStr, { bold: false, size: 20 }), {
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
          new TableCell({
            width: { size: 2319, type: WidthType.DXA },
            borders: cellBorder,
            verticalAlign: VerticalAlign.CENTER,
            children: [
              logoBuffer
                ? new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new ImageRun({
                        data: logoBuffer,
                        type: "jpg",
                        transformation: { width: 55, height: 50 },
                      }),
                    ],
                  })
                : para(run("ТИКК", { size: 20 }), { alignment: AlignmentType.CENTER }),
            ],
          }),
        ],
      }),
    ],
  });
}

function titlePage({ college, topic, subject, course, group, student, teacher }) {
  const logoBuffer = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;
  const children = [];

  children.push(
    para(run(`«${college}»`, { size: SZ.h2, bold: true }), {
      alignment: AlignmentType.CENTER,
    })
  );

  if (logoBuffer) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: logoBuffer,
            type: "jpg",
            transformation: { width: 173, height: 160 },
          }),
        ],
      })
    );
  }

  children.push(
    para(run("СӨЖ", { size: SZ.title, bold: true }), {
      alignment: AlignmentType.CENTER,
    })
  );

  children.push(
    para(
      [run("Тақырыбы: ", { size: SZ.body, bold: true }), run(topic, { size: SZ.body, bold: true })],
      { alignment: AlignmentType.LEFT }
    )
  );

  const infoLines = [
    `Пәні: ${subject}`,
    `Курс: ${course}`,
    `Топ: ${group}`,
    `Студент: ${student}`,
    `Оқытушы: ${teacher}`,
  ];
  infoLines.forEach((line) => {
    children.push(
      para(run(line, { size: SZ.body, bold: false }), {
        alignment: AlignmentType.LEFT,
      })
    );
  });

  return children;
}

function planPage() {
  const items = [
    "I.   КІРІСПЕ",
    "II.  НЕГІЗГІ БӨЛІМ",
    "III. ҚОРЫТЫНДЫ",
    "      ПАЙДАЛАНЫЛҒАН ӘДЕБИЕТТЕР",
  ];
  const children = [
    para(run("ЖОСПАР", { size: SZ.h3, bold: true }), {
      alignment: AlignmentType.CENTER,
      pageBreakBefore: true,
    }),
  ];
  items.forEach((it) => {
    children.push(
      para(run(it, { size: SZ.body }), {
        alignment: AlignmentType.LEFT,
      })
    );
  });
  return children;
}

function sectionHeading(text, opts = {}) {
  return para(run(text, { size: SZ.h2, bold: true }), {
    alignment: AlignmentType.CENTER,
    keepNext: true,
    ...opts,
  });
}

function bodyParagraphs(text) {
  return text
    .split(/\n+/)
    .filter((p) => p.trim().length > 0)
    .map((p) => para(run(p.trim(), { size: SZ.body, bold: false })));
}

async function buildDocx(content, meta) {
  const { college, topic, subject, course, group, student, teacher } = meta;

  const bodyChildren = [];

  // Титульный лист
  bodyChildren.push(...titlePage({ college, topic, subject, course, group, student, teacher }));

  // План (с разрывом страницы)
  bodyChildren.push(...planPage());

  // Кіріспе
  bodyChildren.push(sectionHeading("КІРІСПЕ", { pageBreakBefore: true }));
  bodyChildren.push(...bodyParagraphs(content.kirispe || ""));

  // Негізгі бөлім
  bodyChildren.push(
    sectionHeading("НЕГІЗГІ БӨЛІМ", { pageBreakBefore: !!meta.pageBreakBeforeNegizgi })
  );
  (content.negizgi_bolim || []).forEach((block) => {
    if (block.takyrypsha) {
      bodyChildren.push(
        para(run(block.takyrypsha, { size: SZ.h2, bold: true }), {
          alignment: AlignmentType.LEFT,
          keepNext: true,
        })
      );
    }
    bodyChildren.push(...bodyParagraphs(block.matin || ""));
  });

  // Қорытынды
  bodyChildren.push(sectionHeading("ҚОРЫТЫНДЫ", { pageBreakBefore: true }));
  bodyChildren.push(...bodyParagraphs(content.qorytyndy || ""));

  // Әдебиеттер
  bodyChildren.push(sectionHeading("ПАЙДАЛАНЫЛҒАН ӘДЕБИЕТТЕР"));
  (content.adebietter || []).forEach((ref) => {
    bodyChildren.push(
      para(run(ref, { size: SZ.body, bold: false }), {
        alignment: AlignmentType.LEFT,
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 1134, bottom: 1134, left: 1701, right: 850 },
          },
        },
        headers: {
          default: new Header({
            children: [headerTable(group)],
          }),
        },
        children: bodyChildren,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildDocx };
