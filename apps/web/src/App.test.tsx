import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";

vi.mock("./api", () => ({ api: { config: async () => ({ hasAdmin: true }), me: async () => { throw new Error("unauthorized"); } } }));

describe("App", () => {
  it("shows the Passkey login surface for an existing installation", async () => {
    render(<App/>);
    expect(await screen.findByRole("button", { name: "使用 Passkey 登录" })).toBeInTheDocument();
    expect(screen.getByText("遥控台")).toBeInTheDocument();
  });
});
