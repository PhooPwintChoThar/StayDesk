import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Toaster from "./Toaster.jsx";
import { showToast } from "./toast.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("pop-up notifications", () => {
  it("shows a notification and hides it after its time", () => {
    vi.useFakeTimers();
    render(<Toaster />);

    act(() => {
      showToast(["Reservation number: R-1", "Total: 540 USD"], { title: "Booking received", duration: 5000 });
    });

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("Booking received");
    expect(toast).toHaveTextContent("Total: 540 USD");

    act(() => {
      vi.advanceTimersByTime(4900);
    });
    expect(screen.queryByRole("status")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("can be closed early and stacks several notifications", async () => {
    render(<Toaster />);

    act(() => {
      showToast("First");
      showToast("Second");
    });
    expect(screen.getAllByRole("status")).toHaveLength(2);

    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Second");
  });
});
