-- New inspection outcome. Must be committed before any statement uses the value.
ALTER TYPE public."InspectionAttemptStatus" ADD VALUE IF NOT EXISTS 'TERMINATED';
