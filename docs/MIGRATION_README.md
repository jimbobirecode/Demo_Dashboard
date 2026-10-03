# Database Migration: Hotel Information & Workflow Update

## Overview
This migration adds hotel/lodging information fields and updates the booking workflow from a simple 2-stage process to a comprehensive 4-stage workflow.

## New Workflow States

| State | Description | Who Updates |
|-------|-------------|-------------|
| **Inquiry** | Initial contact, email sent by bot | Bot (automatic) |
| **Requested** | Customer replied with choice | Dashboard (from email) |
| **Confirmed** | Tee time/hotel booked, payment info sent | Dashboard (manual) |
| **Booked** | Payment received, fully complete | Dashboard (manual) |

## New Database Fields

### Hotel Information
- `hotel_checkin` (DATE) - Hotel check-in date
- `hotel_checkout` (DATE) - Hotel check-out date
- `hotel_nights` (INTEGER) - Number of hotel nights
- `hotel_rooms` (INTEGER) - Number of hotel rooms needed
- `hotel_cost` (DECIMAL) - Estimated hotel cost
- `lodging_intent` (TEXT) - Lodging intent/confidence from email parsing

### Golf Information
- `golf_dates` (TEXT[]) - Array of golf play dates
- `golf_courses` (TEXT) - Golf courses requested/booked
- `selected_tee_times` (JSONB) - JSON of selected tee times with details

## Running the Migration

### Option 1: Using psql (Recommended)
```bash
# Connect to your database
psql $DATABASE_URL -f migration_add_hotel_and_workflow.sql
```

### Option 2: Using Python
```python
import psycopg
import os

DATABASE_URL = os.getenv("DATABASE_URL")

with open('migration_add_hotel_and_workflow.sql', 'r') as f:
    migration_sql = f.read()

with psycopg.connect(DATABASE_URL) as conn:
    with conn.cursor() as cursor:
        cursor.execute(migration_sql)
    conn.commit()

print("✅ Migration completed successfully!")
```

### Option 3: Render Dashboard SQL Console
1. Log into Render Dashboard
2. Navigate to your PostgreSQL database
3. Click "SQL" tab
4. Copy and paste the contents of `migration_add_hotel_and_workflow.sql`
5. Click "Run"

## What Gets Updated

### Automatic Updates
- All existing bookings with `status = 'Pending'` will be updated to `status = 'Inquiry'`
- This maintains backward compatibility with existing data

### Data Validation
After running the migration, verify:

```sql
-- Check status distribution
SELECT status, COUNT(*)
FROM bookings
GROUP BY status;

-- Check that Pending bookings were migrated
SELECT COUNT(*) FROM bookings WHERE status = 'Pending';
-- Should return 0

-- Verify new columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'bookings'
  AND column_name IN ('hotel_checkin', 'hotel_checkout', 'hotel_nights',
                      'hotel_rooms', 'hotel_cost', 'golf_dates',
                      'golf_courses', 'selected_tee_times');
```

## Dashboard Changes

### UI Updates
- **Sidebar Stats**: Now shows Inquiry, Requested, Confirmed, Booked counts
- **Main Dashboard**: Updated metrics to track all 4 workflow stages
- **Booking Cards**: Display hotel information when available
- **Status Badges**: New color scheme for workflow states:
  - 🔵 Inquiry (Blue)
  - 🟡 Requested (Yellow/Amber)
  - 🟠 Confirmed (Orange)
  - 🟢 Booked (Green)
- **Action Buttons**: Context-aware workflow progression

### Hotel Information Display
Each booking now shows:
- Check-in/Check-out dates
- Number of nights
- Number of rooms
- Estimated hotel cost
- Golf dates (multiple dates supported)
- Course preferences

## Rollback (if needed)

If you need to rollback this migration:

```sql
-- Revert status changes
UPDATE bookings SET status = 'Pending' WHERE status = 'Inquiry';

-- Remove new columns
ALTER TABLE bookings
DROP COLUMN IF EXISTS hotel_checkin,
DROP COLUMN IF EXISTS hotel_checkout,
DROP COLUMN IF EXISTS hotel_nights,
DROP COLUMN IF EXISTS hotel_rooms,
DROP COLUMN IF EXISTS hotel_cost,
DROP COLUMN IF EXISTS lodging_intent,
DROP COLUMN IF EXISTS golf_dates,
DROP COLUMN IF EXISTS golf_courses,
DROP COLUMN IF EXISTS selected_tee_times;

-- Drop indexes
DROP INDEX IF EXISTS idx_bookings_status;
DROP INDEX IF EXISTS idx_bookings_hotel_checkin;
```

## Next Steps

### For Email Bot Updates
The email bot (`Conolidated.py`) needs to be updated to:
1. Save initial requests with `status = 'Inquiry'`
2. Populate hotel fields: `hotel_checkin`, `hotel_checkout`, `hotel_nights`, `hotel_rooms`, `hotel_cost`
3. Save golf dates array: `golf_dates`
4. Save course preferences: `golf_courses`
5. Save selected tee times: `selected_tee_times`

### Example Bot Insert
```python
cursor.execute("""
    INSERT INTO bookings (
        booking_id, guest_email, date, players, total, status, club,
        hotel_checkin, hotel_checkout, hotel_nights, hotel_rooms, hotel_cost,
        golf_dates, golf_courses, lodging_intent
    ) VALUES (
        %s, %s, %s, %s, %s, 'Inquiry', %s,
        %s, %s, %s, %s, %s,
        %s, %s, %s
    )
""", (
    booking_id, guest_email, first_golf_date, players, total_cost, club,
    checkin_date, checkout_date, nights, rooms, hotel_cost,
    golf_dates_array, courses, lodging_intent
))
```

## Support
If you encounter any issues with the migration, check:
1. Database connection is active
2. You have ALTER TABLE permissions
3. No active transactions are blocking the table
4. Backup your data before running the migration

## Testing
After migration:
1. Verify the dashboard loads without errors
2. Check that existing bookings display correctly
3. Test creating a new booking with hotel information
4. Test the workflow progression (Inquiry → Requested → Confirmed → Booked)
5. Verify email notifications work with new statuses
