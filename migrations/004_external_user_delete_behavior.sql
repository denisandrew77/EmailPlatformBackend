-- Keep historical availability rows when an external carrier account is deleted.

begin;

alter table public."VehicleAvailability"
    drop constraint if exists vehicle_availability_created_by_external_user_fk;

alter table public."VehicleAvailability"
    alter column "createdByExternalUserId" drop not null;

alter table public."VehicleAvailability"
    add constraint vehicle_availability_created_by_external_user_fk
    foreign key ("createdByExternalUserId")
    references public."ExternalUsers"(id)
    on delete set null;

commit;
