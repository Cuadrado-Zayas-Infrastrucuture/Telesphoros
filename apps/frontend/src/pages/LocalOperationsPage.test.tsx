/** @vitest-environment-options {"url":"http://127.0.0.1:4180"} */
import {render,screen,fireEvent} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {beforeEach,it,expect,vi} from 'vitest';
import LocalOperationsPage from './LocalOperationsPage';
const mocks=vi.hoisted(()=>({roles:['reviewer'],apiFetch:vi.fn()}));
vi.mock('@/auth/AuthProvider',()=>({useAuth:()=>mocks}));
beforeEach(()=>{mocks.roles=['reviewer'];mocks.apiFetch.mockReset();});
const renderPage=()=>render(<MemoryRouter><LocalOperationsPage/></MemoryRouter>);
it('does not fetch or write on initial render and requires explicit confirmation',()=>{renderPage();expect(mocks.apiFetch).not.toHaveBeenCalled();expect(screen.getByText('Raise dispute')).toBeDisabled();fireEvent.click(screen.getByLabelText('I reviewed the selected record and intend this synthetic change'));expect(screen.getByText('Raise dispute')).toBeEnabled();});
it('clinician cannot raise even after confirmation',()=>{mocks.roles=['clinician'];renderPage();fireEvent.click(screen.getByLabelText('I reviewed the selected record and intend this synthetic change'));expect(screen.getByText('Raise dispute')).toBeDisabled();});
it('editing the cell after confirming requires a new confirmation',()=>{renderPage();fireEvent.click(screen.getByLabelText('I reviewed the selected record and intend this synthetic change'));fireEvent.change(screen.getByLabelText('Row'),{target:{value:'Intermediate Metabolizer'}});expect(screen.getByText('Raise dispute')).toBeDisabled();});
it('only admin is offered the full-ledger control',()=>{renderPage();expect(screen.queryByText('Verify full ledger')).not.toBeInTheDocument();});
