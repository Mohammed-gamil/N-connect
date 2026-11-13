import { expect, type Locator, type Page, test } from "@playwright/test";

async function dragByCoords(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 16 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function centerOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing boundingBox for locator");
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    box,
  };
}

test.describe("Dragology Canvas Prototype", () => {
  test("drag-and-drop palette chips, move node with grid snap, drag-connect ports, edit config, undo/redo, and serialize WorkflowDefinitionV1", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await expect(
      page.getByText("Integration Hub — Canvas Prototype"),
    ).toBeVisible();

    const svg = page.locator("svg").first();
    const svgBox = await svg.boundingBox();
    expect(svgBox).not.toBeNull();

    // 1) Drag ClickUp chip from palette into When slot (center at 120 + 114, 200 + 52)
    const clickupChip = await centerOf(
      page.getByTestId("palette-chip-clickup"),
    );
    await dragByCoords(
      page,
      clickupChip.x,
      clickupChip.y,
      svgBox!.x + 120 + 114,
      svgBox!.y + 200 + 52,
    );

    const clickupNode = page.getByTestId("canvas-node-clickup-1");
    await expect(clickupNode).toBeVisible();
    expect(Number(await clickupNode.getAttribute("data-x"))).toBe(120);
    expect(Number(await clickupNode.getAttribute("data-y"))).toBe(200);

    // Drag Slack chip from palette into Then slot (center at 500 + 114, 200 + 52)
    const slackChip = await centerOf(page.getByTestId("palette-chip-slack"));
    await dragByCoords(
      page,
      slackChip.x,
      slackChip.y,
      svgBox!.x + 500 + 114,
      svgBox!.y + 200 + 52,
    );

    const slackNode = page.getByTestId("canvas-node-slack-1");
    await expect(slackNode).toBeVisible();
    expect(Number(await slackNode.getAttribute("data-x"))).toBe(500);
    expect(Number(await slackNode.getAttribute("data-y"))).toBe(200);

    // Also test free-drop of Webhook onto canvas (far from When slot) and then Undo it
    const webhookChip = await centerOf(
      page.getByTestId("palette-chip-webhook"),
    );
    await dragByCoords(
      page,
      webhookChip.x,
      webhookChip.y,
      svgBox!.x + 420,
      svgBox!.y + 390,
    );
    const webhookNode = page.getByTestId("canvas-node-webhook-1");
    await expect(webhookNode).toBeVisible();
    const whX = Number(await webhookNode.getAttribute("data-x"));
    const whY = Number(await webhookNode.getAttribute("data-y"));
    expect(whX % 20).toBe(0);
    expect(whY % 20).toBe(0);
    expect(whY).toBeGreaterThanOrEqual(100);

    // Undo free-drop webhook
    await page.getByTestId("undo-btn").click();
    await expect(webhookNode).toHaveCount(0);

    // 2) Move ClickUp node via pointer drag and verify 20px grid snap
    const clickupCenter = await centerOf(clickupNode);
    await dragByCoords(
      page,
      clickupCenter.x,
      clickupCenter.y,
      clickupCenter.x - 36,
      clickupCenter.y + 43,
    );
    const movedX = Number(await clickupNode.getAttribute("data-x"));
    const movedY = Number(await clickupNode.getAttribute("data-y"));
    expect(movedX).toBeLessThan(120);
    expect(movedY).toBeGreaterThan(200);
    expect(movedX % 20).toBe(0);
    expect(movedY % 20).toBe(0);

    // 3) Connect ClickUp -> Slack via pointer drag on port handle
    const outPort = await centerOf(page.getByTestId("port-out-clickup-1"));
    const inPort = await centerOf(page.getByTestId("port-in-slack-1"));
    await dragByCoords(page, outPort.x, outPort.y, inPort.x, inPort.y);

    const wireGroup = page.getByTestId("wire-conn-1");
    await expect(wireGroup).toBeVisible();
    const wirePath = page.getByTestId("wire-path-conn-1");
    await expect(wirePath).toBeAttached();
    await expect(wirePath).toHaveClass(/wire-animated/);

    // 4) Live sentence preview banner
    await expect(page.getByTestId("sentence-preview")).toContainText(
      "When a task is created in ClickUp, send a message to #general in Slack.",
    );

    // 5) Edit ClickUp trigger event & Slack channel + message with variable chip
    await clickupNode.click();
    await page.getByTestId("node-event-select").selectOption("task.completed");
    await expect(page.getByTestId("sentence-preview")).toContainText(
      "When a task is completed in ClickUp, send a message to #general in Slack.",
    );

    await slackNode.click();
    await page.getByTestId("field-channel").selectOption("C0456DEF");
    await expect(page.getByTestId("sentence-preview")).toContainText(
      "When a task is completed in ClickUp, send a message to #engineering in Slack.",
    );

    await page.getByTestId("var-chip-task.url").click();
    await expect(page.getByTestId("field-message")).toHaveValue(
      /\{\{task\.name\}\}.*\{\{task\.url\}\}/,
    );

    // 6) Undo / Redo test
    await page.getByTestId("undo-btn").click();
    await expect(page.getByTestId("field-message")).not.toHaveValue(
      /\{\{task\.url\}\}/,
    );
    await page.getByTestId("redo-btn").click();
    await expect(page.getByTestId("field-message")).toHaveValue(
      /\{\{task\.url\}\}/,
    );

    // 7) Keyboard nudge test (focus node, press ArrowRight)
    await clickupNode.focus();
    await page.keyboard.press("ArrowRight");
    expect(Number(await clickupNode.getAttribute("data-x"))).toBe(movedX + 20);

    // 8) Verify serialized WorkflowDefinitionV1 JSON inspector
    await page.getByTestId("toggle-json-btn").click();
    const jsonText = await page
      .getByTestId("workflow-json-output")
      .textContent();
    expect(jsonText).toBeTruthy();
    const parsed = JSON.parse(jsonText!);
    expect(parsed.definition.version).toBe(1);
    expect(parsed.definition.trigger.application).toBe("clickup");
    expect(parsed.definition.trigger.event).toBe("task.completed");
    expect(parsed.definition.action.application).toBe("slack");
    expect(parsed.definition.action.event).toBe("message.send");
    expect(parsed.definition.action.configuration.channel).toEqual({
      value: "C0456DEF",
      label: "#engineering",
    });
    expect(parsed.layout.nodes.trigger).toEqual({
      x: movedX + 20,
      y: movedY,
    });
    expect(parsed.layout.nodes.action).toEqual({ x: 500, y: 200 });

    expect(errors).toEqual([]);
  });

  test("click-to-add and click-to-connect accessibility flow", async ({
    page,
  }) => {
    await page.goto("/");

    await page.getByTestId("quick-add-clickup").click();
    await page.getByTestId("quick-add-slack").click();

    await expect(page.getByTestId("canvas-node-clickup-1")).toBeVisible();
    await expect(page.getByTestId("canvas-node-slack-1")).toBeVisible();

    // Select ClickUp node and click "Connect to..."
    await page.getByTestId("canvas-node-clickup-1").click();
    await page.getByTestId("connect-to-btn").click();
    await expect(page.getByTestId("connect-to-btn")).toContainText(
      "Click target action node",
    );

    // Click Slack node to complete connection
    await page.getByTestId("canvas-node-slack-1").click();

    await expect(page.getByTestId("wire-end-conn-1")).toBeVisible();
    await expect(page.getByTestId("wire-path-conn-1")).toBeAttached();
    await expect(page.getByTestId("wire-path-conn-1")).toHaveClass(
      /wire-animated/,
    );
    await expect(page.getByTestId("sentence-preview")).toContainText(
      "When a task is created in ClickUp, send a message to #general in Slack.",
    );

    await page.getByTestId("toggle-json-btn").click();
    const parsed = JSON.parse(
      (await page.getByTestId("workflow-json-output").textContent())!,
    );
    expect(parsed.definition.version).toBe(1);
    expect(parsed.definition.trigger.application).toBe("clickup");
    expect(parsed.definition.action.application).toBe("slack");
  });
});
