-- Update VehicleAvailability category constraint to match the current app labels.
--
-- Run once in the Supabase SQL editor.

begin;

update public."VehicleAvailability"
set "vehicleCategory" = '3.5T Box'
where "vehicleCategory" = '3.5T';

alter table public."VehicleAvailability"
    drop constraint if exists "VehicleAvailability_vehicleCategory_check";

alter table public."VehicleAvailability"
    add constraint "VehicleAvailability_vehicleCategory_check"
    check (
        "vehicleCategory" in (
            'Caddy',
            '3.5T Box',
            '3.5T CurtainSide',
            '7.5T Truck - 24T Truck'
        )
    );

commit;
