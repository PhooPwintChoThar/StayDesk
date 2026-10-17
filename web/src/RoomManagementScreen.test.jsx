import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RoomManagementScreen, { readPhotos } from "./RoomManagementScreen.jsx";
import { setRole } from "./api.js";
import { calls, makeToken, reply, stubConfirm, renderWithToaster } from "./test-helpers.js";

const roomTypes = [
  { id: "standard", name: "Standard", maxOccupancy: 2, nightlyRate: 150, currency: "USD", roomCount: 1 },
];
const rooms = [
  {
    id: "room-101",
    roomNumber: "101",
    roomTypeId: "standard",
    roomTypeName: "Standard",
    nightlyRate: 150,
    currency: "USD",
    status: "available",
    maintenanceFrom: null,
    maintenanceTo: null,
    upcomingReservations: 2,
  },
];

function mockRoomsApi(overrides = {}) {
  fetch.mockImplementation(async (url, options = {}) => {
    const method = options.method || "GET";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path === "/login") return reply(200, { token: makeToken({ role: "manager", sub: "manager" }) });
    const handler = overrides[`${method} ${path}`];
    if (handler) return handler(options);
    if (method === "GET" && path === "/room-types") return reply(200, { roomTypes });
    if (method === "GET" && path === "/rooms") return reply(200, { rooms });
    return reply(404, { error: "NotFound" });
  });
}

beforeEach(() => {
  setRole("manager");
  vi.stubGlobal("fetch", vi.fn());
  stubConfirm(true);
});

describe("room management", () => {
  it("lists rooms with their type, price, status and upcoming stays", async () => {
    mockRoomsApi();
    renderWithToaster(<RoomManagementScreen />);

    const table = await screen.findByRole("table", { name: "Rooms" });
    expect(screen.queryByRole("table", { name: "Room availability" })).not.toBeInTheDocument();
    const row = await within(table).findByRole("row", { name: /101/ });
    expect(row).toHaveTextContent("Standard");
    expect(row).toHaveTextContent("150.00 USD");
    expect(row).toHaveTextContent("Available");
    expect(row).toHaveTextContent("2");
    expect(screen.queryByText(/hotel/i)).not.toBeInTheDocument();
  });

  it("adds a room with an existing room type", async () => {
    mockRoomsApi({ "POST /rooms": () => reply(201, { id: "room-102" }) });
    renderWithToaster(<RoomManagementScreen />);

    await userEvent.type(await screen.findByLabelText("Room number"), "102");
    await userEvent.selectOptions(screen.getByLabelText("Room type"), "standard");
    await userEvent.click(screen.getByRole("button", { name: "Add room" }));

    await waitFor(() => expect(calls("POST", "/rooms")).toHaveLength(1));
    expect(JSON.parse(calls("POST", "/rooms")[0][1].body)).toEqual({
      roomNumber: "102",
      roomTypeId: "standard",
    });
    expect(await screen.findByText("Room 102 added.")).toBeInTheDocument();
  });

  it("adds a room together with a new room type and its price", async () => {
    mockRoomsApi({ "POST /rooms": () => reply(201, { id: "room-301" }) });
    renderWithToaster(<RoomManagementScreen />);

    await userEvent.type(await screen.findByLabelText("Room number"), "301");
    await userEvent.selectOptions(screen.getByLabelText("Room type"), "__new__");
    await userEvent.type(screen.getByLabelText("New room type name"), "Family Suite");
    await userEvent.clear(screen.getByLabelText("New room type max guests"));
    await userEvent.type(screen.getByLabelText("New room type max guests"), "5");
    await userEvent.type(screen.getByLabelText("New room type price per night"), "320");
    await userEvent.click(screen.getByRole("button", { name: "Add room" }));

    await waitFor(() => expect(calls("POST", "/rooms")).toHaveLength(1));
    expect(JSON.parse(calls("POST", "/rooms")[0][1].body)).toEqual({
      roomNumber: "301",
      newRoomType: { name: "Family Suite", maxOccupancy: 5, nightlyRate: 320 },
    });
  });

  it("schedules maintenance and shows the conflict when the room is reserved", async () => {
    mockRoomsApi({
      "PUT /rooms/room-101/maintenance": () =>
        reply(409, { message: "Room 101 is reserved during that period (2099-01-02 to 2099-01-04)." }),
    });
    renderWithToaster(<RoomManagementScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "Set maintenance" }));
    const from = screen.getByLabelText("Out of service from");
    await userEvent.clear(from);
    await userEvent.type(from, "2099-01-01");
    await userEvent.type(screen.getByLabelText("Back in service on"), "2099-01-05");
    await userEvent.click(screen.getByRole("button", { name: "Save maintenance" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("reserved during that period");
    expect(JSON.parse(calls("PUT", "/rooms/room-101/maintenance")[0][1].body)).toEqual({
      from: "2099-01-01",
      to: "2099-01-05",
    });
  });

  it("only offers Available and Maintenance states", async () => {
    mockRoomsApi();
    renderWithToaster(<RoomManagementScreen />);

    await screen.findByRole("table", { name: "Rooms" });
    expect(screen.queryByText(/unavailable|inactive/i)).not.toBeInTheDocument();
  });

  it("uploads several photos for a room type and removes one", async () => {
    const withPhotos = [{ ...roomTypes[0], photos: [{ id: "ph-1", url: "/room-types/standard/photos/ph-1" }] }];
    mockRoomsApi({
      "GET /room-types": () => reply(200, { roomTypes: withPhotos }),
      "POST /room-types/standard/photos": () => reply(201, withPhotos[0]),
      "DELETE /room-types/standard/photos/ph-1": () => reply(200, { ...withPhotos[0], photos: [] }),
    });
    renderWithToaster(<RoomManagementScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "Photos" }));
    const files = [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      new File(["b"], "b.png", { type: "image/png" }),
      new File(["c"], "c.webp", { type: "image/webp" }),
    ];
    await userEvent.upload(screen.getByLabelText("Add Standard photos"), files);
    await userEvent.click(await screen.findByRole("button", { name: "Upload 3 photos" }));

    await waitFor(() => expect(calls("POST", "/room-types/standard/photos")).toHaveLength(1));
    const form = calls("POST", "/room-types/standard/photos")[0][1].body;
    expect(form.getAll("photos").map((file) => file.name)).toEqual(["a.jpg", "b.png", "c.webp"]);

    await userEvent.click(screen.getByRole("button", { name: "Remove Standard photo 1" }));
    await waitFor(() => expect(calls("DELETE", "/room-types/standard/photos/ph-1")).toHaveLength(1));
  });
});

describe("room cards", () => {
  it("shows photos with a gallery, the stay total and scarcity", async () => {
    const { default: RoomCards } = await import("./RoomCards.jsx");
    const onSelect = vi.fn();
    render(
      <RoomCards
        nights={3}
        onSelect={onSelect}
        rooms={[{
          roomTypeId: "deluxe", name: "Deluxe", description: "Balcony", maxOccupancy: 4,
          nightlyRate: 240, currency: "USD", roomsAvailable: 1,
          photos: [{ id: "a", url: "/room-types/deluxe/photos/a" }, { id: "b", url: "/room-types/deluxe/photos/b" }],
        }]}
      />,
    );

    expect(screen.getByAltText("Deluxe photo 1 of 2")).toHaveAttribute("src", expect.stringContaining("/room-types/deluxe/photos/a"));
    await userEvent.click(screen.getByRole("button", { name: "Next Deluxe photo" }));
    expect(screen.getByAltText("Deluxe photo 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("USD 720 total")).toBeInTheDocument();
    expect(screen.getByText("Only 1 room left!")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Select Deluxe" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ roomTypeId: "deluxe" }));
  });
});

describe("photo files picked in Safari", () => {
  it("copies photo bytes into memory when they are chosen", async () => {
    const original = new File(["jpeg-bytes"], "room.jpg", { type: "image/jpeg" });

    const [copy] = await readPhotos([original]);

    expect(copy).not.toBe(original);
    expect(copy.name).toBe("room.jpg");
    expect(copy.type).toBe("image/jpeg");
    expect(copy.size).toBe(original.size);
  });

  it("names a photo that can no longer be read", async () => {
    const gone = new File(["x"], "IMG_0042.jpg", { type: "image/jpeg" });
    gone.arrayBuffer = () => Promise.reject(new Error("NotReadableError"));

    await expect(readPhotos([gone])).rejects.toThrow("IMG_0042.jpg could not be read");
  });

  it("keeps a new room type and explains when its photos fail to upload", async () => {
    setRole("manager");
    mockRoomsApi({
      "POST /room-types": () => reply(201, { id: "master", name: "Master", photos: [] }),
      "POST /room-types/master/photos": () => {
        throw new TypeError("Load failed");
      },
    });
    renderWithToaster(<RoomManagementScreen />);

    await userEvent.type(await screen.findByLabelText("Room type name", { selector: "input[aria-label='Room type name']" }), "Master");
    await userEvent.type(screen.getByLabelText("Room type price per night"), "300");
    await userEvent.upload(screen.getByLabelText("Room type photos"), new File(["a"], "a.jpg", { type: "image/jpeg" }));
    expect(await screen.findByText("1 photo(s) selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add room type" }));

    expect(await screen.findByText(/Room type Master was saved, but its photos could not be uploaded \(Load failed\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Room type name", { selector: "input[aria-label='Room type name']" })).toHaveValue("");
  });
});

