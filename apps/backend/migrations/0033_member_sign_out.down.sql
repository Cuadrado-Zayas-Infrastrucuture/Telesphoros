-- Removes the sign-out cut-off function. Changes no data: the tokens_valid_after values it set stay in place, which only refuses older tokens.
DROP FUNCTION member_sign_out();
