import ExcelJS from "exceljs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { priceScenario, type Workspace } from "../../shared/bid";

const text = (value: string) => value || "—";

export async function workspaceDocx(workspace: Workspace): Promise<Buffer> {
  const { data } = workspace;
  const children: Paragraph[] = [
    new Paragraph({
      text: "INTERNAL REVIEW PACKAGE — HUMAN APPROVAL REQUIRED",
      heading: HeadingLevel.HEADING_3,
    }),
    new Paragraph({ text: data.name, heading: HeadingLevel.TITLE }),
    new Paragraph(
      `Customer: ${text(data.customer)}    Solicitation: ${text(data.solicitationId)}`
    ),
    new Paragraph(
      `Type: ${data.type}    Due: ${text(data.dueDate)}    Stage: ${data.stage}`
    ),
    new Paragraph({
      text: "Compliance matrix",
      heading: HeadingLevel.HEADING_1,
    }),
  ];

  for (const requirement of data.requirements) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${requirement.mandatory ? "Mandatory" : "Optional"}: `,
            bold: true,
          }),
          new TextRun(requirement.text),
        ],
        bullet: { level: 0 },
      })
    );
    children.push(
      new Paragraph(
        `Status: ${requirement.status} | Source: ${text(requirement.reference)} | Quote: ${text(requirement.quote)}`
      )
    );
  }

  children.push(
    new Paragraph({
      text: "Response sections",
      heading: HeadingLevel.HEADING_1,
    })
  );
  for (const section of data.sections) {
    children.push(
      new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2 })
    );
    if (section.guidance)
      children.push(new Paragraph(`Guidance: ${section.guidance}`));
    for (const line of (section.content || "No draft yet.").split("\n")) {
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading)
        children.push(
          new Paragraph({
            text: heading[2],
            heading:
              heading[1].length === 1
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          })
        );
      else {
        const bullet = line.match(/^[-*]\s+(.+)/);
        const runs = (bullet ? bullet[1] : line).split(/(\*\*[^*]+\*\*)/).map(
          part =>
            new TextRun({
              text: part.startsWith("**") ? part.slice(2, -2) : part,
              bold: part.startsWith("**"),
            })
        );
        children.push(
          new Paragraph({
            children: runs,
            ...(bullet ? { bullet: { level: 0 } } : {}),
          })
        );
      }
    }
    if (section.citations.length)
      children.push(
        new Paragraph(`Citations: ${section.citations.join("; ")}`)
      );
    if (section.gaps.length)
      children.push(
        new Paragraph(`Open evidence gaps: ${section.gaps.join("; ")}`)
      );
  }

  children.push(
    new Paragraph({ text: "Strategy", heading: HeadingLevel.HEADING_1 })
  );
  for (const [label, values] of Object.entries(data.strategy)) {
    children.push(new Paragraph(`${label}: ${values.join("; ") || "—"}`));
  }

  return Buffer.from(
    await Packer.toBuffer(new Document({ sections: [{ children }] }))
  );
}

export async function workspaceXlsx(workspace: Workspace): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BidForge";
  workbook.created = new Date();

  const matrix = workbook.addWorksheet("Compliance matrix");
  matrix.columns = [
    { header: "ID", key: "id", width: 20 },
    { header: "Requirement", key: "text", width: 55 },
    { header: "Category", key: "category", width: 20 },
    { header: "Mandatory", key: "mandatory", width: 12 },
    { header: "Status", key: "status", width: 16 },
    { header: "Section", key: "section", width: 24 },
    { header: "Owner", key: "owner", width: 22 },
    { header: "Source document", key: "reference", width: 28 },
    { header: "Exact quote", key: "quote", width: 70 },
    { header: "Evidence", key: "evidence", width: 45 },
  ];
  for (const requirement of workspace.data.requirements) {
    matrix.addRow({
      ...requirement,
      mandatory: requirement.mandatory ? "Yes" : "No",
    });
  }
  matrix.getRow(1).font = { bold: true };
  matrix.views = [{ state: "frozen", ySplit: 1 }];
  matrix.autoFilter = { from: "A1", to: "J1" };

  const pricing = workbook.addWorksheet("Price to win");
  pricing.columns = [
    { header: "Scenario", key: "name", width: 28 },
    { header: "Labor", key: "labor", width: 14 },
    { header: "Other", key: "other", width: 14 },
    { header: "Overhead %", key: "overhead", width: 14 },
    { header: "Margin %", key: "margin", width: 14 },
    { header: "Competitor low", key: "competitorLow", width: 18 },
    { header: "Competitor high", key: "competitorHigh", width: 18 },
    { header: "Cost base", key: "cost", width: 18 },
    { header: "Indicative price", key: "price", width: 20 },
    { header: "Profit", key: "profit", width: 18 },
    { header: "Rationale", key: "rationale", width: 50 },
    { header: "Assumptions", key: "assumptions", width: 50 },
  ];
  workspace.data.scenarios.forEach(scenario =>
    pricing.addRow({ ...scenario, ...priceScenario(scenario) })
  );
  pricing.getRow(1).font = { bold: true };
  pricing.views = [{ state: "frozen", ySplit: 1 }];

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
