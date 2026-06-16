-- Migration: Create verification_codes table for custom email verification
-- Run this SQL in your Supabase SQL Editor

CREATE TABLE public.verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  code VARCHAR(6) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  verified BOOLEAN DEFAULT FALSE,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 5
);

-- Create index for fast lookups by user_id and email
CREATE INDEX idx_verification_codes_user_id ON public.verification_codes(user_id);
CREATE INDEX idx_verification_codes_email ON public.verification_codes(email);
CREATE INDEX idx_verification_codes_expires ON public.verification_codes(expires_at);

-- Enable Row Level Security
ALTER TABLE public.verification_codes ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own codes
CREATE POLICY "Users can view own verification codes"
  ON public.verification_codes
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Allow insert
CREATE POLICY "Allow insert verification codes"
  ON public.verification_codes
  FOR INSERT
  WITH CHECK (true);

-- Policy: Allow update status
CREATE POLICY "Allow update verification codes"
  ON public.verification_codes
  FOR UPDATE
  USING (true)
  WITH CHECK (true);
