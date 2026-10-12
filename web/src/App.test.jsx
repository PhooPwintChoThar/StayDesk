import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});

describe('hotel booking interface', () => {
  it('searches availability and renders matching rooms', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        availability: [{
          roomTypeId: 'standard',
          available: true,
          roomsAvailable: 2,
          nightlyRate: 120,
          currency: 'USD'
        }]
      })
    });

    render(<App />);
    await userEvent.type(screen.getByLabelText('Check-in'), '2027-03-10');
    await userEvent.type(screen.getByLabelText('Check-out'), '2027-03-12');
    await userEvent.click(screen.getByRole('button', { name: 'Search availability' }));

    expect(await screen.findByText(/standard — 2/)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/availability?'),
      expect.objectContaining({ method: undefined })
    );
  });

  it('completes a booking and shows confirmation', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          availability: [{
            roomTypeId: 'standard',
            available: true,
            roomsAvailable: 1,
            nightlyRate: 100,
            currency: 'USD'
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          reservationNo: 'R-10001',
          guestId: 'guest-1',
          roomTypeId: 'standard',
          checkIn: '2027-03-10',
          checkOut: '2027-03-12',
          totalAmount: 200,
          currency: 'USD',
          status: 'confirmed'
        })
      });

    render(<App />);
    await userEvent.type(screen.getByLabelText('Check-in'), '2027-03-10');
    await userEvent.type(screen.getByLabelText('Check-out'), '2027-03-12');
    await userEvent.click(screen.getByRole('button', { name: 'Search availability' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));

    await userEvent.type(screen.getByLabelText('Email'), 'guest@example.com');
    await userEvent.type(screen.getByLabelText('First name'), 'Test');
    await userEvent.type(screen.getByLabelText('Last name'), 'Guest');
    await userEvent.type(screen.getByLabelText('Deposit amount'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Book room' }));

    expect(await screen.findByRole('heading', { name: 'Booking confirmed' })).toBeInTheDocument();
    expect(screen.getByText('R-10001')).toBeInTheDocument();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const bookingRequest = fetch.mock.calls[1][1];
    expect(bookingRequest.method).toBe('POST');
    expect(JSON.parse(bookingRequest.body)).toMatchObject({
      roomTypeId: 'standard',
      depositAmount: 50,
      guest: { email: 'guest@example.com', firstName: 'Test', lastName: 'Guest' }
    });

    const table = screen.getByRole('table');
    expect(within(table).getByText('R-10001')).toBeInTheDocument();
  });
});