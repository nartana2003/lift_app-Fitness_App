// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "@/components/PageHeader";

describe("component test capability (PageHeader)", () => {
  it("renders the title as a heading", () => {
    render(<PageHeader title="Progress" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Progress");
  });

  it("renders no back link when back is omitted", () => {
    render(<PageHeader title="Home" />);
    expect(screen.queryByLabelText("Back")).not.toBeInTheDocument();
  });

  it("renders a back link pointing at the given href", () => {
    render(<PageHeader title="Exercise" back="/exercises" />);
    expect(screen.getByLabelText("Back")).toHaveAttribute("href", "/exercises");
  });

  it("renders the right slot", () => {
    render(<PageHeader title="Profile" right={<button>Edit</button>} />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("runs in a DOM environment with IndexedDB available", () => {
    expect(typeof document).toBe("object");
    expect(typeof indexedDB).toBe("object");
  });
});
