{% test foil_summary_valid(model) %}
select * from {{ model }}
where aep_p90_mwh > aep_p50_mwh or aep_p90_mwh <= 0
   or lcoe_cost_p90_eur_mwh < lcoe_cost_p50_eur_mwh
   or positive_npv_probability not between 0 and 1
   or abs(npv_eur - (pv_revenue_eur - pv_cost_eur)) > 0.00001
   or abs(lcoe_eur_mwh * pv_energy_mwh - pv_cost_eur) > 0.00001
   or (scenario != 'foil-investment' and abs(lcoe_eur_mwh - reference_lcoe_eur_mwh) > 0.00001)
{% endtest %}
